/**
 * The Configuration preview's presentation model (product gap 12). Pure: it turns the
 * draft into the request the core previews, decides whether a preview is needed or needs
 * confirmation, and resolves the current labels for the report's ids.
 */
import { m } from '#lib/paraglide/messages.js';
import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
import { kindMode } from '#lib/shared/select-mode.ts';
import { ApiError } from '#lib/client/api-error.ts';
import type {
	Agitation,
	AttributeMoveImpact,
	CardinalitySurface,
	ConfigurationPreview,
	ConfigurationPreviewTotals,
	ConfigurationResolutions,
	Language,
	RemovedAnswerHolder,
	RemovedAnswerImpact,
	WorkerAttributeDefinition,
	WorkerAttributeKind
} from '#lib/domain-vocabulary.ts';
import { attributeWrites, type ConfigurationPreviewRequest } from '#lib/client/workers-api.ts';
import { attributeTypeLabel, toWorkerAttributeDefinitions } from './attribute-draft.ts';
import {
	planConfigurationSave,
	visibleValues,
	type ConfigurationDraft,
	type ValueEntry
} from './configuration-draft.ts';
import type { AttributeDraft } from './attribute-draft.ts';

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
 * The request that asks the core for the Short forms of the draft's values. It proposes the
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

/** One holder's chosen resolution; `replacement === undefined` means not chosen yet. */
export type PreviewHolderChoice = {
	replacement?: string | null;
	/** For a lossy cardinality surface: the one answer it keeps, or `null` for no answer. */
	retained?: string | null;
};

/** The state of one holder row keyed by its removed answer, Worker and surface. */
export type PreviewHolderChoices = Record<string, PreviewHolderChoice>;

export function holderKey(
	attributeId: string,
	answerId: string,
	workerId: string,
	surface?: string
): string {
	return [attributeId, answerId, workerId, surface ?? ''].join('\u0000');
}

/** One holder row the confirmation renders and the organizer resolves. */
export type PreviewHolderRow = {
	key: string;
	workerId: string;
	workerName: string;
	kind: 'worker' | 'workerDraft';
	/** For a Worker draft holder: its unfinished update (`draft`) or base. */
	surface?: 'draft' | 'base';
	emptyIfUnanswered: boolean;
	/** The holder's current value, phrased with the current Attribute and answer names. */
	summary: string;
	replacements: { answerId: string; label: string }[];
	/** A removed whole Attribute: no replacement exists, only the removal itself. */
	attributeRemoval?: boolean;
	/** An Attribute move holder: naming the move acknowledges its lost values; no choice is made. */
	acknowledgement?: boolean;
	/** An Attribute move holder's kept answers and where they stay, when it also loses some. */
	keeps?: string;
	/** The removed Attribute whose answers this row loses, for the dialog's copy. */
	attributeName?: string;
	/** Set for a Worker value or draft that must keep exactly one held answer. */
	cardinalitySurface?: CardinalitySurface;
	/** The answers a cardinality surface holds, with their current labels. */
	heldAnswers?: { answerId: string; label: string }[];
	choice: PreviewHolderChoice;
};

/** One changed answer or whole Attribute with the holders it affects. */
export type PreviewResolutionGroup = {
	key: string;
	attributeId: string;
	answerId: string;
	/** Set only for a removed whole Attribute. */
	removedAttributeId?: string;
	/** Set only for a Worker cardinality change's lossy surfaces. */
	cardinalityAttributeId?: string;
	/** Set only for a lossy Attribute move: naming the group acknowledges its lost values. */
	attributeMove?: boolean;
	/** Set only for a select-mode change that trims held values: naming the group acknowledges them. */
	modeChangeAttributeId?: string;
	/** The surviving answer a merge folds this one into; absent for a removal. */
	mergeInto?: string;
	title: string;
	detail: string;
	rows: PreviewHolderRow[];
};

/**
 * Whether an Attribute move has lost values a Save must acknowledge. A move with no lost value,
 * or with no holder at all, changes nothing a Worker holds and needs no group.
 */
function attributeMoveIsLossy(impact: AttributeMoveImpact): boolean {
	return impact.holders.some((holder) => holder.lostAnswerIds.length > 0);
}

/**
 * A moved answer's current label. The source's saved answers come first: the draft has already
 * taken the answer out of the source, so only the saved list still names it there.
 */
function attributeMoveLabel(
	impact: AttributeMoveImpact,
	saved: ReadonlyMap<string, WorkerAttributeDefinition>,
	draft: ReadonlyMap<string, WorkerAttributeDefinition>,
	answerId: string
): string {
	const lists = [
		saved.get(impact.sourceAttributeId)?.answers,
		draft.get(impact.targetAttributeId)?.answers,
		draft.get(impact.sourceAttributeId)?.answers,
		saved.get(impact.targetAttributeId)?.answers
	];
	for (const answers of lists) {
		if (answers?.some((answer) => answer.id === answerId)) {
			return answerDisplayLabel(answers, answerId);
		}
	}
	return answerId;
}

/** Whether a holder has an explicit resolution, including its empty choice. */
function holderChoiceComplete(row: PreviewHolderRow): boolean {
	// Naming a lossy Attribute move is its acknowledgement; there is no replacement to choose.
	if (row.acknowledgement) return true;
	if (row.cardinalitySurface) {
		// A lossy surface must name the one answer it keeps, or answer no answer at all.
		const retained = row.choice.retained;
		if (retained === undefined) return false;
		if (retained === null) return true;
		return (row.heldAnswers ?? []).some((answer) => answer.answerId === retained);
	}
	// A removed whole Attribute has no replacement to choose: naming it is the resolution.
	if (row.attributeRemoval) return true;
	const { replacement } = row.choice;
	if (replacement === undefined) return false;
	if (replacement === null) return true;
	return row.replacements.some((candidate) => candidate.answerId === replacement);
}

/** Every affected holder has its explicit replacement or no-answer choice. */
export function resolutionsComplete(groups: readonly PreviewResolutionGroup[]): boolean {
	return groups.every((group) => group.rows.every(holderChoiceComplete));
}

/**
 * The Save body's resolutions from the organizer's choices. Only completed rows are
 * included; the caller checks `resolutionsComplete` first.
 */
export function resolutionsFromPreview(
	preview: ConfigurationPreview,
	groups: readonly PreviewResolutionGroup[]
): ConfigurationResolutions {
	const choices = new Map(groups.flatMap((group) => group.rows.map((row) => [row.key, row])));

	const removedAnswers = preview.removedAnswers.map((impact) => ({
		attributeId: impact.attributeId,
		answerId: impact.answerId,
		holders: groups
			.filter(
				(group) =>
					!group.attributeMove &&
					group.attributeId === impact.attributeId &&
					group.answerId === impact.answerId
			)
			.flatMap((group) =>
				group.rows.map((row) => {
					const choice = choices.get(row.key)?.choice ?? {};
					const resolution: ConfigurationResolutions['removedAnswers'][number]['holders'][number] =
						{ workerId: row.workerId };
					if (row.surface !== undefined) resolution.surface = row.surface;
					if (choice.replacement) resolution.replacement = choice.replacement;
					return resolution;
				})
			)
	}));

	// A removed Attribute is acknowledged by its presence; its holders lose the question
	// and choose no replacement.
	const removedAttributes = preview.removedAttributes
		.filter((impact) => impact.holders.length > 0)
		.map((impact) => ({ attributeId: impact.attributeId }));

	// Every lossy Worker value, draft update, and draft base keeps one answer, or explicitly
	// none. The confirm gate proves no row is unresolved; an incomplete row is left out so
	// the core refuses it rather than inventing a choice.
	const cardinality = preview.cardinality.map((impact) => ({
		attributeId: impact.attributeId,
		holders: groups
			.filter((group) => group.cardinalityAttributeId === impact.attributeId)
			.flatMap((group) => group.rows)
			.filter((row) => row.choice.retained !== undefined)
			.map((row) => ({
				workerId: row.workerId,
				surface: row.cardinalitySurface as CardinalitySurface,
				retained: row.choice.retained ?? null
			}))
	}));

	// Every lossy Attribute move is named once: the organizer's naming is the acknowledgement.
	const attributeMoves = preview.attributeMoves
		.filter(attributeMoveIsLossy)
		.map((impact) => ({ sourceAttributeId: impact.sourceAttributeId, answerId: impact.answerId }));

	// Every select-mode change that trims held values is named once, by its Attribute.
	const modeChanges = preview.modeChanges.map((impact) => ({ attributeId: impact.attributeId }));

	return { removedAnswers, removedAttributes, cardinality, attributeMoves, modeChanges };
}

export type PreviewSummaryRow = {
	key: string;
	title: string;
	detail: string;
	lossy: boolean;
};

/** The shared vocabulary labels a preview's stable ids resolve against. */
export type PreviewVocabulary = {
	savedAgitations: readonly Agitation[];
	draftAgitations: readonly ValueEntry<'text'>[];
	savedLanguages: readonly Language[];
	draftLanguages: readonly ValueEntry<'name'>[];
};

function workerCount(count: number): string {
	return m.configuration_count_workers({ count });
}

function answerCount(count: number): string {
	return m.configuration_count_values({ count });
}

function savedValueCount(count: number): string {
	return m.configuration_count_saved_values({ count });
}

/** The answer ids one saved or draft value holds, as a list. */
function heldIds(holder: RemovedAnswerHolder): string[] {
	const value = holder.value;
	if (value === undefined) return [];
	return typeof value === 'string' ? (value ? [value] : []) : value;
}

/**
 * The resolution groups a Save needs: one per removed leaf answer, with each affected saved
 * value and draft surface and the replacements available to it. A holder named by the
 * preview has an explicit choice in `choices` until the organizer makes it.
 */
export function buildResolutionGroups(
	preview: ConfigurationPreview,
	savedConfiguration: readonly WorkerAttributeDefinition[],
	draftAttributes: readonly AttributeDraft[],
	choices: PreviewHolderChoices
): PreviewResolutionGroup[] {
	const saved = new Map(savedConfiguration.map((attribute) => [attribute.id, attribute]));
	const draft = new Map(
		toWorkerAttributeDefinitions(draftAttributes).map((attribute) => [attribute.id, attribute])
	);
	const attributeName = (id: string): string => draft.get(id)?.name ?? saved.get(id)?.name ?? id;
	const answerName = (attributeId: string, answerId: string): string => {
		const candidates = [draft.get(attributeId)?.answers, saved.get(attributeId)?.answers];
		for (const answers of candidates) {
			if (answers?.some((answer) => answer.id === answerId)) {
				return answerDisplayLabel(answers, answerId);
			}
		}
		return answerId;
	};

	const summary = (attributeId: string, holder: RemovedAnswerHolder): string => {
		const labels = heldIds(holder).map((answerId) => answerName(attributeId, answerId));
		return `${attributeName(attributeId)}: ${labels.join(', ') || m.configuration_preview_no_value()}`;
	};

	const answerGroups: PreviewResolutionGroup[] = preview.removedAnswers.map(
		(impact: RemovedAnswerImpact) => {
			const mergeInto = impact.mergeInto;
			const rows = impact.holders.map((holder) => {
				const key = holderKey(
					impact.attributeId,
					impact.answerId,
					holder.workerId,
					holder.surface ?? holder.kind
				);
				return {
					key,
					workerId: holder.workerId,
					workerName: holder.workerName,
					kind: holder.kind,
					...(holder.surface !== undefined ? { surface: holder.surface } : {}),
					emptyIfUnanswered: holder.emptyIfUnanswered,
					summary: summary(impact.attributeId, holder),
					replacements: holder.replacements.map((replacement) => ({
						answerId: replacement.answerId,
						label: answerName(impact.attributeId, replacement.answerId)
					})),
					// A merge has one outcome: every holder follows the chosen survivor.
					choice: choices[key] ?? (mergeInto ? { replacement: mergeInto } : {})
				};
			});

			const answer = answerName(impact.attributeId, impact.answerId);
			const attribute = attributeName(impact.attributeId);
			const survivorName = mergeInto ? answerName(impact.attributeId, mergeInto) : '';
			const affectedWorkers = workerCount(impact.affectedWorkers);
			return {
				key: `${impact.attributeId}:${impact.answerId}`,
				attributeId: impact.attributeId,
				answerId: impact.answerId,
				...(mergeInto ? { mergeInto } : {}),
				title: mergeInto
					? m.configuration_preview_group_merge_title({ answer, survivor: survivorName })
					: m.configuration_preview_group_remove_title({ answer }),
				detail: mergeInto
					? m.configuration_preview_detail_merge_worker({
							attribute,
							workers: affectedWorkers,
							answer: survivorName
						})
					: m.configuration_preview_detail_resolve_worker({
							attribute,
							workers: affectedWorkers
						}),
				rows
			};
		}
	);

	// A removed whole Attribute has no replacement to choose; the organizer acknowledges it.
	// Saved Worker values and Worker drafts are named so no answer disappears silently.
	const removedAttributeGroups: PreviewResolutionGroup[] = preview.removedAttributes
		.filter((impact) => impact.holders.length > 0)
		.map((impact) => {
			const name = attributeName(impact.attributeId);
			const rows: PreviewHolderRow[] = impact.holders.map((holder) => {
				const key = holderKey(
					impact.attributeId,
					'',
					holder.workerId,
					holder.surface ?? holder.kind
				);
				return {
					key,
					workerId: holder.workerId,
					workerName: holder.workerName,
					kind: holder.kind,
					...(holder.surface !== undefined ? { surface: holder.surface } : {}),
					emptyIfUnanswered: holder.emptyIfUnanswered,
					summary: summary(impact.attributeId, holder),
					replacements: [],
					attributeRemoval: true,
					attributeName: name,
					choice: choices[key] ?? {}
				};
			});
			return {
				key: `${impact.attributeId}:removedAttribute`,
				attributeId: impact.attributeId,
				answerId: '',
				removedAttributeId: impact.attributeId,
				title: m.configuration_preview_group_remove_attribute_title({ name }),
				detail: m.configuration_preview_detail_remove_attribute({
					name,
					workers: workerCount(impact.affectedWorkers)
				}),
				rows
			};
		});

	// A Multi-Select to Single-Select change names every saved value, draft update, and
	// draft base that holds several answers, so each is resolved deliberately.
	const cardinalityGroups: PreviewResolutionGroup[] = preview.cardinality.map((impact) => {
		const name = attributeName(impact.attributeId);
		const rows: PreviewHolderRow[] = impact.holders.map((holder) => {
			const key = holderKey(impact.attributeId, 'cardinality', holder.workerId, holder.surface);
			const heldAnswers = holder.held.map((answerId) => ({
				answerId,
				label: answerName(impact.attributeId, answerId)
			}));
			return {
				key,
				workerId: holder.workerId,
				workerName: holder.workerName,
				kind: holder.surface === 'value' ? 'worker' : 'workerDraft',
				...(holder.surface === 'value' ? {} : { surface: holder.surface }),
				emptyIfUnanswered: false,
				summary: `${name}: ${heldAnswers.map((answer) => answer.label).join(', ')}`,
				replacements: [],
				cardinalitySurface: holder.surface,
				heldAnswers,
				choice: choices[key] ?? {}
			};
		});
		return {
			key: `${impact.attributeId}:cardinality`,
			attributeId: impact.attributeId,
			answerId: '',
			cardinalityAttributeId: impact.attributeId,
			title: m.configuration_cardinality_group_title({ name }),
			detail: m.configuration_cardinality_group_detail({ name, count: rows.length }),
			rows
		};
	});

	// A lossy Attribute move names every holder that loses values. Each row is acknowledged by
	// the group itself, so the organizer confirms the move rather than choosing a replacement.
	const attributeMoveGroups: PreviewResolutionGroup[] = preview.attributeMoves
		.filter(attributeMoveIsLossy)
		.map((impact) => {
			const target = attributeName(impact.targetAttributeId);
			const source = attributeName(impact.sourceAttributeId);
			const label = (answerId: string) => attributeMoveLabel(impact, saved, draft, answerId);
			const answer = label(impact.answerId);
			const rows: PreviewHolderRow[] = impact.holders.map((holder) => {
				const loses = holder.lostAnswerIds.map(label);
				const keeps = holder.keptAnswerIds.map(label);
				const keptLine =
					keeps.length > 0
						? m.configuration_preview_attribute_move_keeps({
								worker: holder.workerName,
								values: keeps.join(', '),
								attribute: target
							})
						: undefined;
				return {
					key: holderKey(
						impact.sourceAttributeId,
						impact.answerId,
						holder.workerId,
						'attributeMove'
					),
					workerId: holder.workerId,
					workerName: holder.workerName,
					kind: 'worker',
					emptyIfUnanswered: false,
					summary:
						loses.length > 0
							? m.configuration_preview_attribute_move_loses({
									worker: holder.workerName,
									values: loses.join(', ')
								})
							: (keptLine ?? m.configuration_preview_no_value()),
					...(loses.length > 0 && keptLine !== undefined ? { keeps: keptLine } : {}),
					replacements: [],
					acknowledgement: true,
					choice: {}
				};
			});
			const workers = workerCount(impact.affectedWorkers);
			return {
				key: `${impact.sourceAttributeId}:${impact.answerId}:attributeMove`,
				attributeId: impact.sourceAttributeId,
				answerId: impact.answerId,
				attributeMove: true,
				title: impact.promoted
					? m.configuration_preview_group_attribute_promote_title({ answer })
					: m.configuration_preview_group_attribute_move_title({ answer, target }),
				detail: impact.promoted
					? m.configuration_preview_detail_attribute_promote({ workers, source })
					: m.configuration_preview_detail_attribute_move({ workers, source, target }),
				rows
			};
		});

	// A select-mode change that trims held values lists each Worker surface with what it keeps
	// and loses (the first branch in value order stays). Naming the group acknowledges it.
	const modeChangeGroups: PreviewResolutionGroup[] = preview.modeChanges.map((impact) => {
		const name = attributeName(impact.attributeId);
		const label = (answerId: string) => answerName(impact.attributeId, answerId);
		const rows: PreviewHolderRow[] = impact.holders.map((holder) => ({
			key: holderKey(impact.attributeId, 'selectMode', holder.workerId, holder.surface),
			workerId: holder.workerId,
			workerName: holder.workerName,
			kind: holder.surface === 'value' ? 'worker' : 'workerDraft',
			...(holder.surface === 'value' ? {} : { surface: holder.surface }),
			emptyIfUnanswered: false,
			summary: m.configuration_preview_mode_row({
				worker:
					holder.surface === 'value'
						? holder.workerName
						: `${holder.workerName} (${holder.surface === 'draft' ? m.configuration_cardinality_surface_draft_update() : m.configuration_cardinality_surface_draft_base()})`,
				kept: holder.kept.map(label).join(', ') || m.configuration_preview_no_value(),
				dropped: holder.dropped.map(label).join(', ')
			}),
			replacements: [],
			acknowledgement: true,
			choice: {}
		}));
		return {
			key: `${impact.attributeId}:selectMode`,
			attributeId: impact.attributeId,
			answerId: '',
			modeChangeAttributeId: impact.attributeId,
			title: m.configuration_preview_group_mode_title({ name }),
			detail: m.configuration_preview_group_mode_detail({ count: rows.length }),
			rows
		};
	});

	return [
		...answerGroups,
		...removedAttributeGroups,
		...cardinalityGroups,
		...attributeMoveGroups,
		...modeChangeGroups
	];
}

export function summarizePreview(
	preview: ConfigurationPreview,
	savedConfiguration: readonly WorkerAttributeDefinition[],
	draftAttributes: readonly AttributeDraft[],
	vocabulary?: PreviewVocabulary
): PreviewSummaryRow[] {
	const saved = new Map(savedConfiguration.map((attribute) => [attribute.id, attribute]));
	const draft = new Map(
		toWorkerAttributeDefinitions(draftAttributes).map((attribute) => [attribute.id, attribute])
	);

	const attributeName = (id: string | undefined): string => {
		if (!id) return m.configuration_preview_attribute_fallback();
		return draft.get(id)?.name ?? saved.get(id)?.name ?? id;
	};
	const answerName = (attributeId: string | undefined, answerId: string | undefined): string => {
		if (!answerId) return m.configuration_preview_answer_fallback();
		const candidates = [
			draft.get(attributeId ?? '')?.answers,
			saved.get(attributeId ?? '')?.answers
		];
		for (const answers of candidates) {
			if (answers?.some((answer) => answer.id === answerId)) {
				return answerDisplayLabel(answers, answerId);
			}
		}
		return answerId;
	};
	const attributeKind = (id: string): WorkerAttributeKind | undefined =>
		draft.get(id)?.kind ?? saved.get(id)?.kind;
	const agitationLabel = (id: string): string =>
		vocabulary?.draftAgitations.find((agitation) => agitation.id === id)?.text ??
		vocabulary?.savedAgitations.find((agitation) => agitation.id === id)?.text ??
		id;
	const languageLabel = (id: string): string =>
		vocabulary?.draftLanguages.find((language) => language.id === id)?.name ??
		vocabulary?.savedLanguages.find((language) => language.id === id)?.name ??
		id;
	const sharedLabel = (entity: 'agitation' | 'language', id: string): string =>
		entity === 'agitation' ? agitationLabel(id) : languageLabel(id);

	const row = (
		change: ConfigurationPreview['changes'][number],
		title: string,
		detail: string
	): PreviewSummaryRow => ({
		key: `${change.entity}:${change.id}:${change.operation}`,
		title,
		detail,
		lossy: change.lossyWorkers > 0 || change.discardedValues > 0
	});

	return preview.changes.map((change) => {
		if (change.entity === 'attribute') {
			const name = attributeName(change.id);
			if (change.operation === 'remove') {
				const impact = preview.removedAttributes.find(
					(candidate) => candidate.attributeId === change.id
				);
				if (impact && impact.holders.length > 0) {
					return row(
						change,
						m.configuration_preview_group_remove_attribute_title({ name }),
						m.configuration_preview_row_remove_attribute({
							workers: workerCount(impact.affectedWorkers)
						})
					);
				}
				const detail =
					change.affectedWorkers === 0
						? m.configuration_preview_row_remove_definition()
						: m.configuration_preview_row_remove_definition_discards({
								values: answerCount(change.discardedValues),
								workers: workerCount(change.affectedWorkers)
							});
				return row(change, m.configuration_preview_group_remove_attribute_title({ name }), detail);
			}
			if (change.operation === 'selectMode') {
				return row(
					change,
					m.configuration_preview_row_mode_title({ name }),
					m.configuration_preview_row_mode_detail({
						workers: workerCount(change.affectedWorkers),
						values: answerCount(change.discardedValues)
					})
				);
			}
			if (change.operation === 'convert') {
				const kind = attributeKind(change.id);
				const retention =
					kind === 'category'
						? change.lossyWorkers > 0
							? m.configuration_cardinality_retention()
							: m.configuration_cardinality_no_loss()
						: m.configuration_preview_row_convert_keeps();
				const loss =
					change.discardedValues === 0
						? m.configuration_preview_row_convert_none()
						: m.configuration_preview_row_convert_discards({
								values: answerCount(change.discardedValues)
							});
				return row(
					change,
					kind
						? m.configuration_preview_row_convert_title({
								name,
								type: attributeTypeLabel(kind)
							})
						: m.configuration_preview_row_convert_type_title({ name }),
					`${workerCount(change.affectedWorkers)} affected; ${loss} ${retention}`
				);
			}
			return row(
				change,
				m.configuration_preview_row_change_title({ name }),
				m.configuration_preview_row_definition_change()
			);
		}

		if (change.entity === 'answer') {
			const answer = answerName(change.attributeId, change.id);
			const attribute = attributeName(change.attributeId);
			if (change.operation === 'moveToAttribute' || change.operation === 'promote') {
				const impact = preview.attributeMoves.find(
					(candidate) =>
						candidate.sourceAttributeId === change.attributeId && candidate.answerId === change.id
				);
				if (!impact) {
					return row(
						change,
						m.configuration_preview_row_change_title({ name: attribute }),
						m.configuration_preview_row_definition_change()
					);
				}
				const lossy = attributeMoveIsLossy(impact);
				const target = attributeName(impact.targetAttributeId);
				const workers = workerCount(impact.affectedWorkers);
				const title =
					change.operation === 'promote'
						? m.configuration_preview_group_attribute_promote_title({ answer })
						: m.configuration_preview_group_attribute_move_title({ answer, target });
				// A move that loses nothing says so; only lost values name the source and target.
				const detail = !lossy
					? m.configuration_preview_row_attribute_move_kept({ workers })
					: change.operation === 'promote'
						? m.configuration_preview_detail_attribute_promote({ workers, source: attribute })
						: m.configuration_preview_detail_attribute_move({
								workers,
								source: attribute,
								target
							});
				return { ...row(change, title, detail), lossy };
			}
			if (change.operation === 'move') {
				const move = preview.moves.find(
					(candidate) =>
						candidate.attributeId === change.attributeId && candidate.answerId === change.id
				);
				if (!move)
					return row(
						change,
						m.configuration_move_row_title({ answer }),
						m.configuration_move_row_detail()
					);
				const previousPath = move.previousPath.join(' / ');
				const nextPath = move.path.join(' / ');
				const destination = move.parentId
					? answerName(change.attributeId, move.parentId)
					: m.configuration_move_root();
				const detail =
					move.affectedWorkers === 0
						? m.configuration_move_row_detail_empty({ previous: previousPath, next: nextPath })
						: m.configuration_move_row_detail_kept({
								workers: workerCount(move.affectedWorkers),
								previous: previousPath,
								next: nextPath
							});
				return row(change, m.configuration_move_row_under({ answer, destination }), detail);
			}
			if (change.operation === 'merge') {
				const survivor = answerName(change.attributeId, change.survivorId);
				return row(
					change,
					m.configuration_preview_group_merge_title({ answer, survivor }),
					m.configuration_preview_row_merge_detail({
						workers: workerCount(change.affectedWorkers),
						attribute
					})
				);
			}
			const impact = preview.removedAnswers.find(
				(candidate) =>
					candidate.attributeId === change.attributeId && candidate.answerId === change.id
			);
			if (impact) {
				const detail =
					impact.holders.length > 0
						? m.configuration_preview_row_remove_value_worker({
								workers: workerCount(impact.affectedWorkers)
							})
						: m.configuration_preview_row_remove_value_none_held();
				return {
					...row(change, m.configuration_preview_row_remove_value_title({ answer }), detail),
					lossy: impact.removedValues > 0
				};
			}
			const detail =
				change.affectedWorkers === 0
					? m.configuration_preview_row_remove_value_none()
					: m.configuration_preview_row_remove_value_discards({
							values: answerCount(change.discardedValues),
							workers: workerCount(change.affectedWorkers)
						});
			return row(change, m.configuration_preview_row_remove_value_title({ answer }), detail);
		}

		// A shared Agitation or Language. Its id is resolved in the Worksite's own words,
		// never reconstructed from the entity type.
		const label = sharedLabel(change.entity, change.id);
		const kind =
			change.entity === 'agitation'
				? m.configuration_preview_entity_agitation()
				: m.configuration_preview_entity_language();
		if (change.operation === 'merge') {
			const survivor = sharedLabel(change.entity, change.survivorId ?? '');
			const detail =
				change.affectedWorkers === 0
					? m.configuration_preview_row_shared_merge_clean()
					: m.configuration_preview_row_shared_merge_affected({
							workers: workerCount(change.affectedWorkers)
						});
			return row(
				change,
				m.configuration_preview_group_merge_title({ answer: label, survivor }),
				detail
			);
		}
		const detail =
			change.affectedWorkers === 0
				? m.configuration_preview_row_shared_remove_clean()
				: m.configuration_preview_row_shared_remove_discards({
						values: answerCount(change.discardedValues),
						workers: workerCount(change.affectedWorkers)
					});
		return row(
			change,
			m.configuration_preview_row_remove_shared_title({ name: label, kind }),
			detail
		);
	});
}

/**
 * The overall effect line above the per-change rows. Attribute and shared changes count
 * saved Worker values and draft surfaces; a cardinality change keeps its own sentence.
 */
export function previewSummarySentence(
	totals: ConfigurationPreviewTotals,
	changes: readonly ConfigurationPreview['changes'][number][] = [],
	removedAnswers: readonly RemovedAnswerImpact[] = [],
	removedAttributes: readonly ConfigurationPreview['removedAttributes'][number][] = [],
	cardinality: readonly ConfigurationPreview['cardinality'][number][] = []
): string {
	// A lossy Attribute move removes values from their Attribute; it never adds them to the target.
	if (
		changes.some(
			(change) => change.operation === 'moveToAttribute' || change.operation === 'promote'
		) &&
		totals.discardedValues > 0
	) {
		return m.configuration_preview_summary_attribute_move_loss({
			workers: workerCount(totals.affectedWorkers),
			values: answerCount(totals.discardedValues)
		});
	}

	// A cardinality change resolves Worker values and draft update/base surfaces.
	if (cardinality.length > 0 && removedAnswers.length === 0 && removedAttributes.length === 0) {
		const discarded = answerCount(totals.discardedValues);
		return m.configuration_cardinality_summary({
			workers: workerCount(totals.affectedWorkers),
			discarded
		});
	}
	// Removing answers or definitions with holders resolves their saved values and draft
	// surfaces. With no holder there is nothing to resolve, so the clean summary below
	// describes the definition-only change.
	if ((removedAnswers.length > 0 || removedAttributes.length > 0) && totals.affectedWorkers > 0) {
		return m.configuration_preview_summary_worker_surfaces({
			workers: workerCount(totals.affectedWorkers)
		});
	}

	// A move is lossless: every answer keeps its identity and holder, and only its path
	// through the hierarchy changes.
	if (changes.length > 0 && changes.every((change) => change.operation === 'move')) {
		return m.configuration_preview_summary_move({
			workers: workerCount(totals.affectedWorkers)
		});
	}

	const entities = new Set(changes.map((change) => change.entity));
	const anyShared = entities.has('agitation') || entities.has('language');
	const sharedOnly =
		anyShared && [...entities].every((entity) => entity === 'agitation' || entity === 'language');

	if (sharedOnly) {
		if (totals.discardedValues === 0) {
			return m.configuration_preview_summary_shared_clean({
				workers: workerCount(totals.affectedWorkers)
			});
		}
		return m.configuration_preview_summary_shared_loss({
			workers: workerCount(totals.affectedWorkers),
			values: savedValueCount(totals.discardedValues)
		});
	}

	if (anyShared) {
		if (totals.discardedValues === 0) {
			return m.configuration_preview_summary_mixed_clean({
				workers: workerCount(totals.affectedWorkers)
			});
		}
		return m.configuration_preview_summary_mixed_loss({
			workers: workerCount(totals.affectedWorkers),
			values: savedValueCount(totals.discardedValues)
		});
	}

	if (totals.discardedValues === 0) {
		return m.configuration_preview_summary_clean({
			workers: workerCount(totals.affectedWorkers)
		});
	}

	return m.configuration_preview_summary_loss({
		workers: workerCount(totals.affectedWorkers),
		values: answerCount(totals.discardedValues)
	});
}

/**
 * The copy the save bar shows when a preview fails (ADR-0024). The core's message is a
 * diagnostic, not screen copy: the stable code picks the words, and the fallback stays
 * generic.
 */
export function previewFailureMessage(error: unknown): string {
	const code = error instanceof ApiError ? error.code : undefined;
	switch (code) {
		case 'attribute_answers_in_use':
			return m.configuration_answers_in_use();
		case 'configuration_answer_has_children':
			return m.configuration_error_answer_has_children();
		case 'configuration_merge_invalid':
			return m.configuration_error_merge_invalid_preview();
		case 'configuration_hierarchy_invalid':
			return m.configuration_error_hierarchy_invalid_preview();
		case 'configuration_sibling_label_conflict':
			return m.configuration_error_sibling_label_conflict();
		case 'invalid_configuration_preview':
			return m.configuration_error_preview_failed();
		default:
			return m.configuration_error_preview_generic();
	}
}

/**
 * The copy the save bar shows when a resolution-aware Save refuses or fails (ADR-0024).
 * The core message never reaches the screen.
 */
export function configurationSaveFailureMessage(error: unknown): string {
	const code = error instanceof ApiError ? error.code : undefined;
	switch (code) {
		case 'attribute_answers_in_use':
			return m.configuration_answers_in_use();
		case 'stale_configuration_preview':
			return m.configuration_error_stale_preview();
		case 'configuration_resolution_required':
			return m.configuration_error_resolution_required();
		case 'configuration_replacement_invalid':
			return m.configuration_error_replacement_invalid();
		case 'configuration_answer_has_children':
			return m.configuration_error_answer_has_children();
		case 'configuration_merge_invalid':
			return m.configuration_error_merge_invalid_save();
		case 'configuration_hierarchy_invalid':
			return m.configuration_error_hierarchy_invalid_save();
		case 'configuration_sibling_label_conflict':
			return m.configuration_error_sibling_label_conflict();
		default:
			return m.configuration_error_save_generic();
	}
}
