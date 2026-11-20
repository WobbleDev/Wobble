/**
 * The live Configuration draft for the current visit. It owns the unsaved edits, so
 * the navigation rail can warn before you switch Worksite.
 */
import { invalidateAll } from '$app/navigation';
import { onDestroy, tick, untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { m } from '#lib/paraglide/messages.js';
import { newId } from '#lib/shared/text/new-id.ts';
import type {
	Agitation,
	Language,
	WorkerAttributeDefinition,
	Worksite
} from '#lib/domain-vocabulary.ts';
import {
	attributeWrites,
	saveAgitations,
	saveAttributes,
	saveConfigurationAttributes,
	saveLanguages,
	saveWorksiteCommitteeGoal,
	saveWorksiteName
} from '#lib/client/configuration-api.ts';
import { configurationSaveFailureMessage } from './preview-failures.ts';
import {
	hasPreviewableConfigurationChanges,
	previewRequest,
	previewRequestKey,
	suggestionRequest
} from './preview-request.ts';
import {
	canSave as computeCanSave,
	canSaveWorksiteName as computeCanSaveWorksiteName,
	getCommitteeGoalError,
	getDirtyState,
	hasUnsavedDraft as computeHasUnsavedDraft,
	attributeSaveBlockReason as computeAttributeSaveBlockReason,
	canPersistAttributes as computeCanPersistAttributes,
	moveValue,
	planConfigurationSave,
	visibleValues,
	type ConfigurationDraft
} from './configuration-draft.ts';
import {
	createAttribute,
	fromWorkerAttributeDefinitions,
	toWorkerAttributeDefinitions,
	type AttributeDraft,
	type AttributeType
} from './attribute-draft.ts';
import { getAttributeNameError } from './attribute-validation.ts';

import { AnswerEditing } from './answer-editing.svelte.ts';
import { PreviewFlow } from './preview-flow.svelte.ts';
import { createValueList } from './value-list.svelte.ts';

export const configurationDraftContextKey = Symbol('configuration-draft');

export type ConfigurationDraftContext = {
	hasUnsavedChanges: boolean;
};

/**
 * Owns the Configuration editor's drafts, derived dirty/save state and the
 * unsaved-changes flag shared through context.
 */
export class ConfigurationDraftState {
	worksiteName = $state('');
	savedWorksiteName = $state('');
	editingName = $state(false);
	draftCommitteeGoal = $state('');
	savedCommitteeGoal = $state(0);

	draftAttributes = $state<AttributeDraft[]>([]);
	savedConfiguration = $state<WorkerAttributeDefinition[]>([]);
	readonly expandedIds = new SvelteSet<string>();
	addFormOpen = $state(false);
	addAttributeName = $state('');
	addAttributeType = $state<AttributeType>('category');
	addAttempted = $state(false);
	deleteDialogOpen = $state(false);
	pendingDeleteId = $state<string | null>(null);

	/**
	 * The Agitation and Language lists. Both follow the same add, remove, rename and merge
	 * rules over a different label field, so they share one list implementation; the editors
	 * and the draft read the list objects themselves.
	 */
	readonly agitations = createValueList({
		field: 'text',
		makeEntry: (id, text) => ({ id, text }),
		duplicateMessage: () => m.configuration_agitation_exists(),
		locked: () => this.saving
	});
	readonly languages = createValueList({
		field: 'name',
		makeEntry: (id, name) => ({ id, name }),
		duplicateMessage: () => m.configuration_language_exists(),
		locked: () => this.saving
	});

	savedAgitations = $state<Agitation[]>([]);
	savedLanguages = $state<Language[]>([]);

	saving = $state(false);
	refreshingData = $state(false);
	errorMessage = $state('');
	refreshErrorMessage = $state('');
	/**
	 * The completion message for the last successful save, announced from a live region
	 * that lives outside the save bar. The bar unmounts the moment nothing is dirty, so
	 * its own status region cannot report the success.
	 */
	saveAnnouncement = $state('');

	/** Attribute answer editing (add, rename, merge, move, reorder) and the suggested Abbreviations. */
	readonly answers = new AnswerEditing({
		attributes: () => this.draftAttributes,
		setAttributes: (next) => {
			this.draftAttributes = next;
		},
		saving: () => this.saving,
		draftInput: () => this.draftInput,
		expandedIds: this.expandedIds
	});

	/** The impact preview and confirmation that runs before a lossy save. */
	readonly previewFlow = new PreviewFlow({
		draftInput: () => this.draftInput,
		view: () => ({
			savedConfiguration: this.savedConfiguration,
			draftAttributes: this.draftAttributes,
			savedAgitations: this.savedAgitations,
			draftAgitations: this.agitations.draft,
			savedLanguages: this.savedLanguages,
			draftLanguages: this.languages.draft
		}),
		clearErrors: () => {
			this.errorMessage = '';
			this.refreshErrorMessage = '';
		},
		fail: (message) => {
			this.errorMessage = message;
		},
		save: () => this.performSave()
	});

	private dirty = $derived(getDirtyState(this.draftInput));
	dirtyName = $derived(this.dirty.name);
	dirtyCommitteeGoal = $derived(this.dirty.committeeGoal);
	dirtyAttributes = $derived(this.dirty.attributes);
	dirtyAgitations = $derived(this.dirty.agitations);
	dirtyLanguages = $derived(this.dirty.languages);
	dirtySections = $derived(this.dirty.sections);
	hasUnsavedDraft = $derived(computeHasUnsavedDraft(this.draftInput));
	canPersistAttributes = $derived(computeCanPersistAttributes(this.draftInput));
	attributeSaveBlockReason = $derived(computeAttributeSaveBlockReason(this.draftInput));
	canSaveWorksiteName = $derived(computeCanSaveWorksiteName(this.draftInput));
	canSave = $derived(computeCanSave(this.draftInput));
	committeeGoalError = $derived(
		this.dirtyCommitteeGoal ? getCommitteeGoalError(this.draftCommitteeGoal) : ''
	);
	showSaveBar = $derived(
		this.saving ||
			this.dirtySections.length > 0 ||
			Boolean(this.errorMessage || this.refreshErrorMessage)
	);
	pendingDeleteAttribute = $derived(
		this.draftAttributes.find((attribute) => attribute.id === this.pendingDeleteId)
	);
	addAttributeNameError = $derived(
		this.addAttempted ? getAttributeNameError(this.addAttributeName, this.draftAttributes) : ''
	);

	constructor(options: {
		attributes: readonly WorkerAttributeDefinition[];
		agitations: readonly Agitation[];
		languages: readonly Language[];
		worksite: Worksite;
		configurationDraft: ConfigurationDraftContext;
	}) {
		const { attributes, agitations, languages, worksite, configurationDraft } = options;

		this.worksiteName = untrack(() => worksite.name);
		this.savedWorksiteName = untrack(() => worksite.name);
		this.draftCommitteeGoal = untrack(() => String(worksite.committeeGoal));
		this.savedCommitteeGoal = untrack(() => worksite.committeeGoal);
		this.draftAttributes = untrack(() => fromWorkerAttributeDefinitions(attributes));
		this.savedConfiguration = untrack(() => toWorkerAttributeDefinitions(this.draftAttributes));
		this.agitations.draft = untrack(() => agitations.map((agitation) => ({ ...agitation })));
		this.savedAgitations = untrack(() => agitations.map((agitation) => ({ ...agitation })));
		this.languages.draft = untrack(() => languages.map((language) => ({ ...language })));
		this.savedLanguages = untrack(() => languages.map((language) => ({ ...language })));

		$effect(() => {
			const unsaved = computeHasUnsavedDraft(this.draftInput);
			configurationDraft.hasUnsavedChanges = unsaved;
			// A save confirmation describes the draft it saved; a new edit clears it so the
			// next save can announce itself again.
			if (unsaved) this.saveAnnouncement = '';
		});

		// Any draft edit makes a pending preview obsolete: the organizer confirmed a
		// consequence that no longer describes the draft.
		$effect(() => {
			const key = previewRequestKey(previewRequest(this.draftInput));
			this.previewFlow.closeIfStale(key);
		});

		// A new, renamed or edited value asks the core for its Abbreviation once typing settles.
		$effect(() => {
			const key = previewRequestKey(suggestionRequest(this.draftInput));
			const timer = setTimeout(() => untrack(() => void this.answers.loadSuggestions(key)), 250);
			return () => clearTimeout(timer);
		});

		onDestroy(() => {
			configurationDraft.hasUnsavedChanges = false;
		});
	}

	private get draftInput(): ConfigurationDraft {
		return {
			worksiteName: this.worksiteName,
			savedWorksiteName: this.savedWorksiteName,
			draftCommitteeGoal: this.draftCommitteeGoal,
			savedCommitteeGoal: this.savedCommitteeGoal,
			draftAttributes: this.draftAttributes,
			savedConfiguration: this.savedConfiguration,
			draftAgitations: this.agitations.draft,
			savedAgitations: this.savedAgitations,
			draftLanguages: this.languages.draft,
			savedLanguages: this.savedLanguages,
			addFormOpen: this.addFormOpen,
			newAgitationText: this.agitations.input,
			newLanguageName: this.languages.input
		};
	}

	toggleExpanded(id: string) {
		if (this.expandedIds.has(id)) {
			this.expandedIds.delete(id);
		} else {
			this.expandedIds.add(id);
		}
	}

	/** Opens the add form above the Attributes list. */
	openAddForm() {
		this.addAttributeName = '';
		this.addAttributeType = 'category';
		this.addAttempted = false;
		this.addFormOpen = true;
	}

	submitAddAttribute(event: SubmitEvent) {
		event.preventDefault();
		const nameError = getAttributeNameError(this.addAttributeName, this.draftAttributes);
		if (nameError) {
			this.addAttempted = true;
			return;
		}

		const attribute = createAttribute(
			newId(),
			this.addAttributeName.trim(),
			this.addAttributeType,
			[]
		);
		this.draftAttributes = [...this.draftAttributes, attribute];
		this.expandedIds.add(attribute.id);
		this.addFormOpen = false;
		// The form that held focus is gone; the next thing to do is add its first option.
		void tick().then(() => document.getElementById(`${attribute.id}-new-option`)?.focus());
	}

	deleteAttribute(id: string) {
		if (this.saving) return;
		this.draftAttributes = this.draftAttributes.filter((attribute) => attribute.id !== id);
		this.expandedIds.delete(id);
		this.pendingDeleteId = null;
		this.deleteDialogOpen = false;
	}

	/** Reorders one Attribute within the one list; Save writes the new `position` order. */
	moveAttribute(id: string, direction: -1 | 1): boolean {
		if (this.saving) return false;
		const next = moveValue(this.draftAttributes, id, direction);
		const changed = next.some(
			(attribute, index) => attribute.id !== this.draftAttributes[index]?.id
		);
		if (!changed) return false;
		this.draftAttributes = next;
		return true;
	}

	requestDeleteAttribute(id: string) {
		if (this.saving) return;
		this.pendingDeleteId = id;
		this.deleteDialogOpen = true;
	}

	/**
	 * Save all: the existing protocol, plus the authoritative impact preview. A draft that
	 * removes, merges or converts saved Attribute answers, or removes or merges a saved
	 * Agitation or Language, is previewed first; actual loss waits for an explicit
	 * confirmation. Confirming does not save by itself: it hands back to the same save
	 * protocol. A preview failure keeps the draft and prevents the save, and a changed
	 * draft invalidates the confirmation before it can be used.
	 */
	async saveAll() {
		if (this.saving || this.previewFlow.loading || !this.canSave) return;

		if (hasPreviewableConfigurationChanges(this.draftInput)) {
			await this.previewFlow.load();
			return;
		}

		await this.performSave();
	}

	private async performSave() {
		if (this.saving || !this.canSave) return;

		this.saving = true;
		this.refreshingData = false;
		this.errorMessage = '';
		this.refreshErrorMessage = '';
		this.saveAnnouncement = '';
		const plan = planConfigurationSave(this.draftInput);
		// The saves run in parallel, so one can land while another is refused.
		let savedAny = false;

		try {
			const saves: Promise<unknown>[] = [];
			if (plan.worksiteName.dirty) {
				const nextName = plan.worksiteName.snapshot;
				saves.push(
					saveWorksiteName(nextName).then(() => {
						savedAny = true;
						this.savedWorksiteName = nextName;
					})
				);
			}
			if (plan.committeeGoal.dirty) {
				const nextTarget = plan.committeeGoal.snapshot;
				saves.push(
					saveWorksiteCommitteeGoal(nextTarget).then(() => {
						savedAny = true;
						this.savedCommitteeGoal = nextTarget;
						this.draftCommitteeGoal = String(nextTarget);
					})
				);
			}
			if (plan.attributes.dirty) {
				const nextConfiguration = plan.attributes.snapshot;
				const pending = this.previewFlow.pendingSave;
				const save = pending
					? saveConfigurationAttributes({
							attributes: attributeWrites(nextConfiguration),
							base: pending.base,
							resolutions: pending.resolutions
						})
					: saveAttributes(nextConfiguration);
				saves.push(
					save.then(() => {
						savedAny = true;
						this.savedConfiguration = nextConfiguration.map((attribute) => ({
							...attribute,
							answers: visibleValues(attribute.answers).map(
								({ id, value, parentId, mode, abbreviation, abbreviationOrigin }) => ({
									id,
									value,
									...(parentId ? { parentId } : {}),
									...(mode ? { mode } : {}),
									...(abbreviationOrigin === 'edited' && abbreviation
										? { abbreviation, abbreviationOrigin }
										: {})
								})
							)
						}));
						// Folded options are gone once saved; the draft drops them too, or it never matches.
						this.draftAttributes = this.draftAttributes.map((attribute) => ({
							...attribute,
							answers: visibleValues(attribute.answers)
						}));
					})
				);
			}
			if (plan.agitations.dirty) {
				const nextAgitations = plan.agitations.snapshot;
				saves.push(
					saveAgitations(nextAgitations).then(() => {
						savedAny = true;
						this.savedAgitations = visibleValues(nextAgitations).map(({ id, text }) => ({
							id,
							text
						}));
						this.agitations.draft = visibleValues(this.agitations.draft);
					})
				);
			}
			if (plan.languages.dirty) {
				const nextLanguages = plan.languages.snapshot;
				saves.push(
					saveLanguages(nextLanguages).then(() => {
						savedAny = true;
						this.savedLanguages = visibleValues(nextLanguages).map(({ id, name }) => ({
							id,
							name
						}));
						this.languages.draft = visibleValues(this.languages.draft);
					})
				);
			}

			const results = await Promise.allSettled(saves);
			const failure = results.find((result) => result.status === 'rejected');
			if (failure?.status === 'rejected') throw failure.reason;
			this.previewFlow.settleSave({ clearChoices: true });
		} catch (error) {
			// The draft stays; a stale or refused plan must be reviewed again before retry.
			this.previewFlow.settleSave({ clearChoices: false });
			this.errorMessage = configurationSaveFailureMessage(error);
			// The parts that did save are real: refresh the header, nav rail and Workers data so
			// they stop showing the old values (for example the old Worksite name).
			if (savedAny) {
				this.refreshingData = true;
				try {
					await invalidateAll();
				} catch {
					this.refreshErrorMessage = m.configuration_refresh_failed();
				} finally {
					this.refreshingData = false;
				}
			}
			this.saving = false;
			return;
		}

		this.refreshingData = true;
		try {
			await invalidateAll();
		} catch {
			this.refreshErrorMessage = m.configuration_refresh_failed();
		} finally {
			this.refreshingData = false;
			this.saving = false;
		}
		// The save bar unmounts as soon as the draft is clean; the editor's persistent live
		// region must carry the completion instead.
		this.saveAnnouncement = String(m.configuration_save_bar_saved());
	}

	async retryRefresh() {
		if (this.saving) return;
		this.saving = true;
		this.refreshingData = true;
		try {
			await invalidateAll();
			this.refreshErrorMessage = '';
		} catch {
			this.refreshErrorMessage = m.configuration_refresh_failed();
		} finally {
			this.refreshingData = false;
			this.saving = false;
		}
	}

	discardAll() {
		if (this.saving) return;
		// Anything in flight belongs to the draft being discarded.
		this.previewFlow.reset();
		this.saveAnnouncement = '';
		this.worksiteName = this.savedWorksiteName;
		this.editingName = false;
		this.draftCommitteeGoal = String(this.savedCommitteeGoal);
		this.draftAttributes = fromWorkerAttributeDefinitions(this.savedConfiguration);
		this.agitations.draft = this.savedAgitations.map((agitation) => ({ ...agitation }));
		this.agitations.input = '';
		this.agitations.error = '';
		this.languages.draft = this.savedLanguages.map((language) => ({ ...language }));
		this.languages.input = '';
		this.languages.error = '';
		this.addFormOpen = false;
		this.addAttempted = false;
		this.expandedIds.clear();
		this.pendingDeleteId = null;
		this.deleteDialogOpen = false;
		this.errorMessage = '';
		this.refreshErrorMessage = '';
	}
}
