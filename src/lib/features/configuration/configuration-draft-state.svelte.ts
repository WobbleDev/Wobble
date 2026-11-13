/**
 * The live Configuration draft for the current visit. It owns the unsaved edits, so
 * the navigation rail can warn before you switch Worksite.
 */
import { invalidateAll } from '$app/navigation';
import { onDestroy, tick, untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { m } from '#lib/paraglide/messages.js';
import { newId } from '#lib/shared/new-id.ts';
import type {
	Agitation,
	Language,
	WorkerAttributeDefinition,
	Worksite
} from '#lib/domain-vocabulary.ts';
import {
	attributeWrites,
	previewConfiguration,
	suggestAbbreviations,
	saveAgitations,
	saveAttributes,
	saveConfigurationAttributes,
	saveLanguages,
	saveWorksiteCommitteeGoal,
	saveWorksiteName
} from '#lib/client/workers-api.ts';
import type { ConfigurationPreview } from '#lib/domain-vocabulary.ts';
import {
	buildResolutionGroups,
	configurationSaveFailureMessage,
	hasPreviewableConfigurationChanges,
	previewFailureMessage,
	previewRequest,
	previewRequestKey,
	suggestionRequest,
	previewRequiresConfirmation as needsPreviewConfirmation,
	previewSummarySentence,
	resolutionsComplete,
	resolutionsFromPreview,
	summarizePreview,
	type PreviewHolderChoice,
	type PreviewHolderChoices
} from './configuration-preview.ts';
import {
	canSave as computeCanSave,
	canSaveWorksiteName as computeCanSaveWorksiteName,
	checkValueText,
	findDuplicateValue,
	getCommitteeGoalError,
	getDirtyState,
	hasUnsavedDraft as computeHasUnsavedDraft,
	attributeSaveBlockReason as computeAttributeSaveBlockReason,
	canPersistAttributes as computeCanPersistAttributes,
	mergeValue,
	moveValue,
	planConfigurationSave,
	removeValue,
	renameValue,
	visibleValues,
	type ConfigurationDraft,
	type ValueEntry,
	type ValueTextCheck
} from './configuration-draft.ts';
import {
	createAttribute,
	fromWorkerAttributeDefinitions,
	toWorkerAttributeDefinitions,
	type AttributeDraft,
	type AttributeType
} from './attribute-draft.ts';
import {
	findDuplicateSiblingOption,
	getAttributeNameError,
	hasChildAnswers,
	hasDuplicateOptionValue,
	isAnswerInSubtree
} from './attribute-validation.ts';
import {
	moveAnswerAmongSiblings,
	moveAnswerBesideSibling,
	moveAnswerBranchToAttribute,
	moveRefusal,
	promoteAnswerBranch,
	promoteRefusal,
	restoreAnswerOrder,
	siblingPosition,
	type MoveSource,
	type MoveTarget
} from './attribute-moves.ts';

import {
	editAbbreviation,
	renameAnswerValue,
	abbreviationTooLong,
	shownAbbreviation
} from './abbreviation-draft.ts';
import type { AttributeAnswerDraft } from './attribute-draft.ts';

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

	draftAgitations = $state<ValueEntry<'text'>[]>([]);
	savedAgitations = $state<Agitation[]>([]);
	newAgitationText = $state('');
	agitationError = $state('');

	draftLanguages = $state<ValueEntry<'name'>[]>([]);
	savedLanguages = $state<Language[]>([]);
	newLanguageName = $state('');
	languageError = $state('');

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

	/**
	 * The core's suggested Short form for each value that has no edited one, by answer id.
	 * The frontend never generates a form: it shows what the preview answered.
	 */
	readonly suggestedAbbreviations = new SvelteMap<string, string>();
	private suggestionToken = 0;

	/** The last preview of the current draft, and whether its confirmation is open. */
	preview = $state<ConfigurationPreview | null>(null);
	previewOpen = $state(false);
	previewing = $state(false);
	private previewKey = $state<string | null>(null);
	/** Bumped on every preview request, so a late reply for an older draft is dropped. */
	private previewToken = 0;
	/** The organizer's explicit resolution for every affected holder. */
	previewChoices = $state<PreviewHolderChoices>({});
	/** The confirmed plan the Save carries; it is cleared when the preview changes. */
	private pendingResolutionSave = $state<{
		base: string;
		resolutions: ReturnType<typeof resolutionsFromPreview>;
	} | null>(null);
	previewRequiresConfirmation = $derived(
		this.preview ? needsPreviewConfirmation(this.preview) : false
	);
	/** Whether the loss being confirmed is of shared values rather than answers. */
	previewSharedLoss = $derived(
		Boolean(
			this.preview?.changes.some(
				(change) =>
					(change.entity === 'agitation' || change.entity === 'language') &&
					(change.lossyWorkers > 0 || change.discardedValues > 0)
			)
		)
	);
	previewRows = $derived(
		this.preview
			? summarizePreview(this.preview, this.savedConfiguration, this.draftAttributes, {
					savedAgitations: this.savedAgitations,
					draftAgitations: this.draftAgitations,
					savedLanguages: this.savedLanguages,
					draftLanguages: this.draftLanguages
				})
			: []
	);
	previewTotals = $derived(this.preview?.totals ?? null);
	previewSummary = $derived(
		this.preview
			? previewSummarySentence(
					this.preview.totals,
					this.preview.changes,
					this.preview.removedAnswers,
					this.preview.removedAttributes,
					this.preview.cardinality
				)
			: ''
	);
	previewResolutionGroups = $derived(
		this.preview
			? buildResolutionGroups(
					this.preview,
					this.savedConfiguration,
					this.draftAttributes,
					this.previewChoices
				)
			: []
	);
	previewResolutionsComplete = $derived(resolutionsComplete(this.previewResolutionGroups));

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
	/** The Agitations and Languages the lists show: folded entries wait for Save out of sight. */
	visibleAgitations = $derived(visibleValues(this.draftAgitations));
	visibleLanguages = $derived(visibleValues(this.draftLanguages));
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
		this.draftAgitations = untrack(() => agitations.map((agitation) => ({ ...agitation })));
		this.savedAgitations = untrack(() => agitations.map((agitation) => ({ ...agitation })));
		this.draftLanguages = untrack(() => languages.map((language) => ({ ...language })));
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
			if (this.previewKey !== null && this.previewKey !== key) {
				this.closePreview();
			}
		});

		// A new, renamed or edited value asks the core for its Short form once typing settles.
		$effect(() => {
			const key = previewRequestKey(suggestionRequest(this.draftInput));
			const timer = setTimeout(() => untrack(() => void this.loadSuggestions(key)), 250);
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
			draftAgitations: this.draftAgitations,
			savedAgitations: this.savedAgitations,
			draftLanguages: this.draftLanguages,
			savedLanguages: this.savedLanguages,
			addFormOpen: this.addFormOpen,
			newAgitationText: this.newAgitationText,
			newLanguageName: this.newLanguageName
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

	addAttributeOption(attribute: AttributeDraft, requestedParentId = ''): string | null {
		const value = attribute.newOption.trim();
		if (!value) {
			attribute.newOptionError = m.configuration_enter_option();
			return null;
		}
		const parentId = requestedParentId || undefined;
		if (hasDuplicateOptionValue(attribute, value, undefined, parentId)) {
			attribute.newOptionError = m.configuration_option_exists();
			return null;
		}

		const id = newId();
		attribute.answers.push({
			id,
			value,
			...(parentId ? { parentId } : {})
		});
		// Unfold the path down to the new answer so it shows where it was added.
		for (
			let ancestorId = parentId;
			ancestorId;
			ancestorId = attribute.answers.find((answer) => answer.id === ancestorId)?.parentId
		) {
			this.expandedIds.add(ancestorId);
		}
		attribute.newOption = '';
		attribute.newOptionError = '';
		attribute.removalError = '';
		attribute.moveError = '';
		return id;
	}

	removeAttributeOption(attributeId: string, optionId: string, removeBranch = false) {
		if (this.saving) return;
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		if (!attribute) return;
		// A parent removal is allowed only after the editor's explicit disposition choice.
		if (hasChildAnswers(attribute, optionId) && !removeBranch) {
			attribute.removalError = m.configuration_answer_has_children();
			return;
		}
		attribute.removalError = '';
		attribute.moveError = '';
		attribute.answers = removeBranch
			? attribute.answers.filter(
					(answer) => !isAnswerInSubtree(attribute.answers, answer.id, optionId)
				)
			: removeValue(attribute.answers, optionId);
	}

	/**
	 * Checks an inline edit of an Attribute answer against its siblings only; a label
	 * another branch already uses is a different path. Applies the rename only when it is
	 * new and not blank.
	 */
	renameAttributeAnswer(attributeId: string, answerId: string, text: string): ValueTextCheck {
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		if (!attribute) return { status: 'blank' };
		if (!text.trim()) return { status: 'blank' };
		const answer = attribute.answers.find((candidate) => candidate.id === answerId);
		const sibling = findDuplicateSiblingOption(attribute, answerId, text, answer?.parentId);
		if (sibling) return { status: 'duplicate', survivorId: sibling.id };

		if (!this.saving) {
			const label = text.trim();
			attribute.answers = attribute.answers.map((candidate) =>
				candidate.id === answerId ? renameAnswerValue(candidate, label) : candidate
			);
			// A generated form follows the new name; the old suggestion no longer describes it.
			this.suggestedAbbreviations.delete(answerId);
			attribute.removalError = '';
			attribute.moveError = '';
		}
		return { status: 'ok' };
	}

	/** Typing a Short form edits it; clearing it returns the value to a generated form. */
	editAbbreviation(attributeId: string, answerId: string, text: string) {
		if (this.saving) return;
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		if (!attribute) return;
		attribute.answers = attribute.answers.map((candidate) =>
			candidate.id === answerId ? editAbbreviation(candidate, text) : candidate
		);
		// A cleared form is generated again: the suggestion held for the old name is stale.
		if (!text.trim()) this.suggestedAbbreviations.delete(answerId);
	}

	/** The text a value's Short form field shows. */
	abbreviationShown(answer: AttributeAnswerDraft): string {
		return shownAbbreviation(answer, this.suggestedAbbreviations);
	}

	/**
	 * Asks the core for the Short form of every value of the draft. A draft the core would
	 * refuse (an over-long form, a blank name) keeps the suggestions it has; the Save bar
	 * explains why it cannot save.
	 */
	async loadSuggestions(expectedKey?: string) {
		const request = suggestionRequest(this.draftInput);
		const key = previewRequestKey(request);
		if (expectedKey !== undefined && key !== expectedKey) return;
		if (this.draftAttributes.some((attribute) => attribute.answers.some(abbreviationTooLong)))
			return;
		const token = ++this.suggestionToken;
		try {
			const forms = await suggestAbbreviations(request);
			if (token !== this.suggestionToken) return;
			this.suggestedAbbreviations.clear();
			for (const form of forms) {
				if (form.shortFormOrigin === 'generated') {
					this.suggestedAbbreviations.set(form.answerId, form.shortForm);
				}
			}
		} catch {
			// The previous suggestions stay; a Save still lets the core generate every form.
		}
	}

	/** Folds an edited Attribute answer into a sibling; applied on Save, undone by Discard. */
	mergeAttributeAnswer(attributeId: string, foldedId: string, survivorId: string) {
		if (this.saving) return;
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		if (!attribute) return;
		attribute.removalError = '';
		attribute.moveError = '';
		const survivor = attribute.answers.find((answer) => answer.id === survivorId);
		attribute.answers = mergeValue(attribute.answers, foldedId, survivorId).map((answer) =>
			answer.id === foldedId
				? {
						...answer,
						...(survivor?.parentId ? { parentId: survivor.parentId } : { parentId: undefined })
					}
				: answer
		);
	}

	/**
	 * Reparents one answer in the draft; descendants follow through their own parent
	 * references. A destination below the moved answer is refused without changing the
	 * draft. A destination whose sibling already uses the label keeps the move in the
	 * draft so it can be renamed in place, while Save all waits for the explicit valid
	 * resolution and the core refuses a colliding proposal with a coded diagnosis.
	 */
	moveAttributeAnswer(attributeId: string, answerId: string, parentId: string) {
		if (this.saving) return;
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		if (!attribute) return;
		const answers = visibleValues(attribute.answers);
		const answer = answers.find((candidate) => candidate.id === answerId);
		if (!answer) return;

		const target = parentId || undefined;
		if (target && !answers.some((candidate) => candidate.id === target)) {
			attribute.moveError = m.configuration_move_parent_missing();
			return;
		}
		if (target && isAnswerInSubtree(answers, target, answerId)) {
			attribute.moveError = m.configuration_move_below_descendant();
			return;
		}

		attribute.answers = attribute.answers.map((candidate) =>
			candidate.id === answerId ? { ...candidate, parentId: target } : candidate
		);
		attribute.moveError = findDuplicateSiblingOption(attribute, answerId, answer.value, target)
			? m.configuration_move_name_conflict()
			: '';
		attribute.removalError = '';
	}

	/** Moves a value one place among its siblings; its new place, or null at an end or while saving. */
	moveAnswerSibling(
		attributeId: string,
		answerId: string,
		direction: -1 | 1
	): { position: number; count: number } | null {
		if (this.saving) return null;
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		const next = attribute && moveAnswerAmongSiblings(attribute.answers, answerId, direction);
		if (!attribute || !next) return null;
		attribute.answers = next;
		return siblingPosition(next, answerId);
	}

	/** Puts a value before or after a sibling; false when they are not siblings or nothing changes. */
	moveAnswerBeside(
		attributeId: string,
		answerId: string,
		targetId: string,
		after: boolean
	): boolean {
		if (this.saving) return false;
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		const next = attribute && moveAnswerBesideSibling(attribute.answers, answerId, targetId, after);
		if (!attribute || !next) return false;
		attribute.answers = next;
		return true;
	}

	/** A value's place among its visible siblings. */
	answerSiblingPlace(attributeId: string, answerId: string): { position: number; count: number } {
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		return siblingPosition(attribute?.answers ?? [], answerId);
	}

	answerOrder(attributeId: string): string[] {
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		return attribute?.answers.map((answer) => answer.id) ?? [];
	}

	restoreAnswerOrder(attributeId: string, order: string[]) {
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		if (attribute) attribute.answers = restoreAnswerOrder(attribute.answers, order);
	}

	/**
	 * Moves an answer branch into another Attribute under a visible parent (or the top level).
	 * A refused move keeps the draft and names the reason on the source Attribute.
	 */
	moveAnswerToAttribute(source: MoveSource, target: MoveTarget): boolean {
		if (this.saving) return false;
		const refusal = moveRefusal(this.draftAttributes, source, target);
		if (refusal) {
			this.setMoveError(source.attributeId, refusal);
			return false;
		}
		const next = moveAnswerBranchToAttribute(this.draftAttributes, source, target);
		if (!next) return false;

		this.draftAttributes = next;
		this.expandPath(target.attributeId, target.parentId);
		return true;
	}

	/**
	 * Turns an answer branch into a new Attribute placed after its source. A refused promotion
	 * keeps the draft and names the reason on the source Attribute.
	 */
	promoteAnswerToAttribute(source: MoveSource): boolean {
		if (this.saving) return false;
		const refusal = promoteRefusal(this.draftAttributes, source);
		if (refusal) {
			this.setMoveError(source.attributeId, refusal);
			return false;
		}
		const next = promoteAnswerBranch(this.draftAttributes, source);
		if (!next) return false;

		// The new Attribute takes the promoted answer's id, so its expansion is that id.
		this.draftAttributes = next;
		this.expandedIds.add(source.answerId);
		return true;
	}

	private setMoveError(attributeId: string, reason: string) {
		const attribute = this.draftAttributes.find((candidate) => candidate.id === attributeId);
		if (attribute) attribute.moveError = reason;
	}

	/** Unfolds an Attribute and the path from its root down to one answer, so a move shows where it landed. */
	private expandPath(attributeId: string, answerId = '') {
		this.expandedIds.add(attributeId);
		const answers =
			this.draftAttributes.find((candidate) => candidate.id === attributeId)?.answers ?? [];
		for (
			let ancestorId = answerId;
			ancestorId;
			ancestorId = answers.find((answer) => answer.id === ancestorId)?.parentId ?? ''
		) {
			this.expandedIds.add(ancestorId);
		}
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

	addAgitation() {
		const text = this.newAgitationText.trim();
		if (!text || this.saving) return;
		if (findDuplicateValue(this.draftAgitations, 'text', null, text)) {
			this.agitationError = m.configuration_agitation_exists();
			return;
		}
		this.draftAgitations = [...this.draftAgitations, { id: newId(), text }];
		this.newAgitationText = '';
		this.agitationError = '';
	}

	submitAgitation(event: SubmitEvent) {
		event.preventDefault();
		this.addAgitation();
	}

	removeAgitation(id: string) {
		if (this.saving) return;
		this.draftAgitations = removeValue(this.draftAgitations, id);
	}

	/** Checks an inline edit; applies the rename only when the text is new and not blank. */
	renameAgitation(id: string, text: string): ValueTextCheck {
		const check = checkValueText(this.draftAgitations, 'text', id, text);
		if (check.status === 'ok' && !this.saving) {
			this.draftAgitations = renameValue(this.draftAgitations, 'text', id, text);
		}
		return check;
	}

	/** Folds an edited Agitation into another one; applied on Save, undone by Discard. */
	mergeAgitation(foldedId: string, survivorId: string) {
		if (this.saving) return;
		this.draftAgitations = mergeValue(this.draftAgitations, foldedId, survivorId);
	}

	addLanguage() {
		const name = this.newLanguageName.trim();
		if (!name || this.saving) return;
		if (findDuplicateValue(this.draftLanguages, 'name', null, name)) {
			this.languageError = m.configuration_language_exists();
			return;
		}
		this.draftLanguages = [...this.draftLanguages, { id: newId(), name }];
		this.newLanguageName = '';
		this.languageError = '';
	}

	submitLanguage(event: SubmitEvent) {
		event.preventDefault();
		this.addLanguage();
	}

	removeLanguage(id: string) {
		if (this.saving) return;
		this.draftLanguages = removeValue(this.draftLanguages, id);
	}

	/** Checks an inline edit; applies the rename only when the name is new and not blank. */
	renameLanguage(id: string, name: string): ValueTextCheck {
		const check = checkValueText(this.draftLanguages, 'name', id, name);
		if (check.status === 'ok' && !this.saving) {
			this.draftLanguages = renameValue(this.draftLanguages, 'name', id, name);
		}
		return check;
	}

	/** Folds an edited Language into another one; applied on Save, undone by Discard. */
	mergeLanguage(foldedId: string, survivorId: string) {
		if (this.saving) return;
		this.draftLanguages = mergeValue(this.draftLanguages, foldedId, survivorId);
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
		if (this.saving || this.previewing || !this.canSave) return;

		if (hasPreviewableConfigurationChanges(this.draftInput)) {
			await this.loadPreview();
			return;
		}

		await this.performSave();
	}

	/** Records one holder's explicit resolution in the open preview. */
	chooseResolution(key: string, choice: PreviewHolderChoice) {
		this.previewChoices = { ...this.previewChoices, [key]: choice };
	}

	/** Asks the core what this draft would change, then confirms or reports the refusal. */
	private async loadPreview() {
		const request = previewRequest(this.draftInput);
		const key = previewRequestKey(request);
		this.errorMessage = '';
		this.refreshErrorMessage = '';
		this.previewing = true;
		this.previewChoices = {};
		this.pendingResolutionSave = null;
		const token = ++this.previewToken;

		try {
			const preview = await previewConfiguration(request);
			// A late reply never describes the draft that replaced it.
			if (token !== this.previewToken) return;
			if (key !== previewRequestKey(previewRequest(this.draftInput))) return;

			if (preview.changes.length === 0) {
				// Only a harmless change reached this point (the preview is requested for
				// consequences); there is nothing to confirm.
				this.closePreview();
				await this.performSave();
				return;
			}

			this.preview = preview;
			this.previewKey = key;
			this.previewOpen = true;
		} catch (error) {
			if (token !== this.previewToken) return;
			this.closePreview();
			this.errorMessage = previewFailureMessage(error);
		} finally {
			if (token === this.previewToken) this.previewing = false;
		}
	}

	/** Confirms the preview that is on screen; the save protocol still performs the write. */
	confirmPreview() {
		const key = this.previewKey;
		if (key === null || !this.preview || !this.previewResolutionsComplete) return;
		const base = this.preview.base;
		const resolutions = resolutionsFromPreview(this.preview, this.previewResolutionGroups);
		this.closePreview();
		if (key !== previewRequestKey(previewRequest(this.draftInput))) return;

		this.pendingResolutionSave = { base, resolutions };
		void this.performSave();
	}

	/** Cancel forgets the preview and keeps the recoverable draft untouched. */
	cancelPreview() {
		this.closePreview();
	}

	private closePreview() {
		this.preview = null;
		this.previewOpen = false;
		this.previewKey = null;
		this.previewChoices = {};
	}

	private async performSave() {
		if (this.saving || !this.canSave) return;

		this.saving = true;
		this.refreshingData = false;
		this.errorMessage = '';
		this.refreshErrorMessage = '';
		this.saveAnnouncement = '';
		const plan = planConfigurationSave(this.draftInput);

		try {
			const saves: Promise<unknown>[] = [];
			if (plan.worksiteName.dirty) {
				const nextName = plan.worksiteName.snapshot;
				saves.push(
					saveWorksiteName(nextName).then(() => {
						this.savedWorksiteName = nextName;
					})
				);
			}
			if (plan.committeeGoal.dirty) {
				const nextTarget = plan.committeeGoal.snapshot;
				saves.push(
					saveWorksiteCommitteeGoal(nextTarget).then(() => {
						this.savedCommitteeGoal = nextTarget;
						this.draftCommitteeGoal = String(nextTarget);
					})
				);
			}
			if (plan.attributes.dirty) {
				const nextConfiguration = plan.attributes.snapshot;
				const pending = this.pendingResolutionSave;
				const save = pending
					? saveConfigurationAttributes({
							attributes: attributeWrites(nextConfiguration),
							base: pending.base,
							resolutions: pending.resolutions
						})
					: saveAttributes(nextConfiguration);
				saves.push(
					save.then(() => {
						this.savedConfiguration = nextConfiguration.map((attribute) => ({
							...attribute,
							answers: visibleValues(attribute.answers).map(
								({ id, value, parentId, mode, shortForm, shortFormOrigin }) => ({
									id,
									value,
									...(parentId ? { parentId } : {}),
									...(mode ? { mode } : {}),
									...(shortFormOrigin === 'edited' && shortForm
										? { shortForm, shortFormOrigin }
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
						this.savedAgitations = visibleValues(nextAgitations).map(({ id, text }) => ({
							id,
							text
						}));
						this.draftAgitations = visibleValues(this.draftAgitations);
					})
				);
			}
			if (plan.languages.dirty) {
				const nextLanguages = plan.languages.snapshot;
				saves.push(
					saveLanguages(nextLanguages).then(() => {
						this.savedLanguages = visibleValues(nextLanguages).map(({ id, name }) => ({
							id,
							name
						}));
						this.draftLanguages = visibleValues(this.draftLanguages);
					})
				);
			}

			const results = await Promise.allSettled(saves);
			const failure = results.find((result) => result.status === 'rejected');
			if (failure?.status === 'rejected') throw failure.reason;
			this.pendingResolutionSave = null;
			this.previewChoices = {};
		} catch (error) {
			// The draft stays; a stale or refused plan must be reviewed again before retry.
			this.pendingResolutionSave = null;
			this.errorMessage = configurationSaveFailureMessage(error);
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
		this.previewToken += 1;
		this.previewing = false;
		this.pendingResolutionSave = null;
		this.saveAnnouncement = '';
		this.closePreview();
		this.worksiteName = this.savedWorksiteName;
		this.editingName = false;
		this.draftCommitteeGoal = String(this.savedCommitteeGoal);
		this.draftAttributes = fromWorkerAttributeDefinitions(this.savedConfiguration);
		this.draftAgitations = this.savedAgitations.map((agitation) => ({ ...agitation }));
		this.newAgitationText = '';
		this.agitationError = '';
		this.draftLanguages = this.savedLanguages.map((language) => ({ ...language }));
		this.newLanguageName = '';
		this.languageError = '';
		this.addFormOpen = false;
		this.addAttempted = false;
		this.expandedIds.clear();
		this.pendingDeleteId = null;
		this.deleteDialogOpen = false;
		this.errorMessage = '';
		this.refreshErrorMessage = '';
	}
}
