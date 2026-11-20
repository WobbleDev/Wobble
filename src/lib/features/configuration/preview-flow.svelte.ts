/**
 * The Configuration save's impact-preview flow: ask the core what a draft would change, hold
 * the preview and the organizer's per-holder resolutions while the confirmation is open, and
 * hand back to the save protocol once they confirm. It owns no draft: the host supplies the
 * draft on demand and performs the save.
 */
import type { Agitation, ConfigurationPreview, Language } from '#lib/domain-vocabulary.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { previewConfiguration } from '#lib/client/configuration-api.ts';
import type { ConfigurationDraft } from './configuration-draft.ts';
import type { AttributeDraft } from './attribute-draft.ts';
import { previewFailureMessage } from './preview-failures.ts';
import {
	previewRequest,
	previewRequestKey,
	previewRequiresConfirmation as needsPreviewConfirmation
} from './preview-request.ts';
import {
	buildResolutionGroups,
	resolutionsComplete,
	resolutionsFromPreview,
	type PreviewHolderChoice,
	type PreviewHolderChoices
} from './preview-resolutions.ts';
import { previewSummarySentence, summarizePreview } from './preview-summary.ts';

/** What the flow reads from, and hands control back to, the draft that owns it. */
export type PreviewFlowHost = {
	draftInput(): ConfigurationDraft;
	/** The saved and draft sides the preview rows and resolution groups describe. */
	view(): {
		savedConfiguration: WorkerAttributeDefinition[];
		draftAttributes: AttributeDraft[];
		savedAgitations: Agitation[];
		draftAgitations: Agitation[];
		savedLanguages: Language[];
		draftLanguages: Language[];
	};
	/** Clears the save and refresh errors when a new preview is requested. */
	clearErrors(): void;
	fail(message: string): void;
	/** The save protocol, run once nothing is left to confirm. */
	save(): Promise<void>;
};

export class PreviewFlow {
	/** The last preview of the current draft, and whether its confirmation is open. */
	preview = $state<ConfigurationPreview | null>(null);
	open = $state(false);
	loading = $state(false);
	private key = $state<string | null>(null);
	/** Bumped on every preview request, so a late reply for an older draft is dropped. */
	private token = 0;
	/** The organizer's explicit resolution for every affected holder. */
	choices = $state<PreviewHolderChoices>({});
	/** The confirmed plan the Save carries; it is cleared when the preview changes. */
	pendingSave = $state<{
		base: string;
		resolutions: ReturnType<typeof resolutionsFromPreview>;
	} | null>(null);

	requiresConfirmation = $derived(this.preview ? needsPreviewConfirmation(this.preview) : false);
	/** Whether the loss being confirmed is of shared values rather than answers. */
	sharedLoss = $derived(
		Boolean(
			this.preview?.changes.some(
				(change) =>
					(change.entity === 'agitation' || change.entity === 'language') &&
					(change.lossyWorkers > 0 || change.discardedValues > 0)
			)
		)
	);
	rows = $derived.by(() => {
		if (!this.preview) return [];
		const view = this.host.view();
		return summarizePreview(this.preview, view.savedConfiguration, view.draftAttributes, {
			savedAgitations: view.savedAgitations,
			draftAgitations: view.draftAgitations,
			savedLanguages: view.savedLanguages,
			draftLanguages: view.draftLanguages
		});
	});
	totals = $derived(this.preview?.totals ?? null);
	summary = $derived(
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
	resolutionGroups = $derived.by(() => {
		if (!this.preview) return [];
		const view = this.host.view();
		return buildResolutionGroups(
			this.preview,
			view.savedConfiguration,
			view.draftAttributes,
			this.choices
		);
	});
	resolutionsComplete = $derived(resolutionsComplete(this.resolutionGroups));

	constructor(private readonly host: PreviewFlowHost) {}

	/** Records one holder's explicit resolution in the open preview. */
	choose(key: string, choice: PreviewHolderChoice) {
		this.choices = { ...this.choices, [key]: choice };
	}

	/** Asks the core what this draft would change, then confirms or reports the refusal. */
	async load() {
		const request = previewRequest(this.host.draftInput());
		const key = previewRequestKey(request);
		this.host.clearErrors();
		this.loading = true;
		this.choices = {};
		this.pendingSave = null;
		const token = ++this.token;

		try {
			const preview = await previewConfiguration(request);
			// A late reply never describes the draft that replaced it.
			if (token !== this.token) return;
			if (key !== previewRequestKey(previewRequest(this.host.draftInput()))) return;

			if (preview.changes.length === 0) {
				// Only a harmless change reached this point (the preview is requested for
				// consequences); there is nothing to confirm.
				this.close();
				await this.host.save();
				return;
			}

			this.preview = preview;
			this.key = key;
			this.open = true;
		} catch (error) {
			if (token !== this.token) return;
			this.close();
			this.host.fail(previewFailureMessage(error));
		} finally {
			if (token === this.token) this.loading = false;
		}
	}

	/** Confirms the preview that is on screen; the save protocol still performs the write. */
	confirm() {
		const key = this.key;
		if (key === null || !this.preview || !this.resolutionsComplete) return;
		const base = this.preview.base;
		const resolutions = resolutionsFromPreview(this.preview, this.resolutionGroups);
		this.close();
		if (key !== previewRequestKey(previewRequest(this.host.draftInput()))) return;

		this.pendingSave = { base, resolutions };
		void this.host.save();
	}

	/** Cancel forgets the preview and keeps the recoverable draft untouched. */
	cancel() {
		this.close();
	}

	/** Any draft edit makes an open preview obsolete: what was confirmed no longer matches. */
	closeIfStale(currentKey: string) {
		if (this.key !== null && this.key !== currentKey) this.close();
	}

	private close() {
		this.preview = null;
		this.open = false;
		this.key = null;
		this.choices = {};
	}

	/** The save finished or was refused: its resolution plan is spent. */
	settleSave(options: { clearChoices: boolean }) {
		this.pendingSave = null;
		if (options.clearChoices) this.choices = {};
	}

	/** Anything in flight belongs to a draft that is being discarded. */
	reset() {
		this.token += 1;
		this.loading = false;
		this.pendingSave = null;
		this.close();
	}
}
