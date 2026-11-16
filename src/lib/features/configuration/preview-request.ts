/**
 * The Configuration preview's request side (product gap 12). Pure: turns the draft into the
 * request the core previews and decides whether a preview is needed or needs confirmation.
 */
import { kindMode } from '#lib/shared/workers/select-mode.ts';
import type { ConfigurationPreview } from '#lib/domain-vocabulary.ts';
import {
	attributeWrites,
	type ConfigurationPreviewRequest
} from '#lib/client/configuration-api.ts';
import { toWorkerAttributeDefinitions } from './attribute-draft.ts';
import {
	planConfigurationSave,
	visibleValues,
	type ConfigurationDraft
} from './configuration-draft.ts';

/** The request's all three proposed sets, built from the same snapshots a save sends. */
export function previewRequest(draft: ConfigurationDraft): ConfigurationPreviewRequest {
	const plan = planConfigurationSave(draft);

	return {
		attributes: attributeWrites(plan.attributes.snapshot),
		agitations: plan.agitations.snapshot.map((agitation) =>
			agitation.mergedInto
				? { id: agitation.id, text: agitation.text, mergedInto: agitation.mergedInto }
				: { id: agitation.id, text: agitation.text }
		),
		languages: plan.languages.snapshot.map((language) =>
			language.mergedInto
				? { id: language.id, name: language.name, mergedInto: language.mergedInto }
				: { id: language.id, name: language.name }
		)
	};
}

/**
 * The request that asks the core for the Abbreviations of the draft's values. It proposes the
 * draft's Attributes against the saved shared values, so edits elsewhere do not repeat it.
 */
export function suggestionRequest(draft: ConfigurationDraft): ConfigurationPreviewRequest {
	return {
		attributes: attributeWrites(toWorkerAttributeDefinitions(draft.draftAttributes)),
		agitations: draft.savedAgitations.map(({ id, text }) => ({ id, text })),
		languages: draft.savedLanguages.map(({ id, name }) => ({ id, name }))
	};
}

/** Identifies one proposed state, so a late reply for an older draft can be dropped. */
export function previewRequestKey(request: ConfigurationPreviewRequest): string {
	return JSON.stringify(request);
}

/**
 * Whether the draft changes Attribute consequences at all: a definition or an answer was
 * removed, an answer was folded away, the type changed, or a branch moved to another
 * parent. A rename, reorder or added answer is harmless and saves without a preview.
 */
export function hasPreviewableAttributeChanges(draft: ConfigurationDraft): boolean {
	const byId = new Map(draft.draftAttributes.map((attribute) => [attribute.id, attribute]));

	for (const saved of draft.savedConfiguration) {
		const next = byId.get(saved.id);
		if (!next) return true;
		if (next.type !== saved.kind) return true;
		if (saved.answers.some((answer) => !next.answers.some((held) => held.id === answer.id))) {
			return true;
		}
		// A value's select mode governs how many of its branches a Worker may hold, so a
		// change of it must be reported even though no answer id changes (ADR 0043).
		if (
			saved.answers.some((answer) => {
				const next_ = next.answers.find((held) => held.id === answer.id);
				if (next_ === undefined) return false;
				const before = answer.mode ?? kindMode(saved.kind);
				const after = next_.mode ?? kindMode(next.type);
				return before !== after && next.answers.some((held) => held.parentId === answer.id);
			})
		) {
			return true;
		}
		// Moving a branch changes its path, so the confirmation must report the affected
		// holders even though no answer id changes.
		if (
			saved.answers.some((answer) => {
				const moved = next.answers.find((held) => held.id === answer.id);
				return moved !== undefined && (moved.parentId ?? '') !== (answer.parentId ?? '');
			})
		) {
			return true;
		}
	}

	return draft.draftAttributes.some((attribute) =>
		attribute.answers.some((answer) => Boolean(answer.mergedInto))
	);
}

/**
 * Whether the draft removes a saved Agitation or Language, or folds one into another: the
 * shared changes that make saved Worker values move or disappear. A rename, reorder or added
 * value changes no saved value and needs no preview.
 */
export function hasPreviewableSharedChanges(draft: ConfigurationDraft): boolean {
	const lists: {
		draft: readonly { id: string; mergedInto?: string }[];
		saved: readonly { id: string }[];
	}[] = [
		{ draft: draft.draftAgitations, saved: draft.savedAgitations },
		{ draft: draft.draftLanguages, saved: draft.savedLanguages }
	];

	return lists.some(({ draft: proposed, saved }) => {
		if (proposed.some((entry) => Boolean(entry.mergedInto))) return true;
		const visible = new Set(visibleValues(proposed).map((entry) => entry.id));
		return saved.some((entry) => !visible.has(entry.id));
	});
}

/** Every staged Configuration change the authoritative Save all preview must describe. */
export function hasPreviewableConfigurationChanges(draft: ConfigurationDraft): boolean {
	return hasPreviewableAttributeChanges(draft) || hasPreviewableSharedChanges(draft);
}

/** Actual loss requires a deliberate confirmation; a pure merge or rename does not. */
export function previewRequiresConfirmation(preview: ConfigurationPreview): boolean {
	return preview.totals.lossyWorkers > 0 || preview.totals.discardedValues > 0;
}
