/**
 * The Configuration preview's resolutions: the holder rows and groups a Save must resolve,
 * the choices made so far, and the resolutions sent with the Save. Pure.
 */
import { m } from '#lib/paraglide/messages.js';
import { answerDisplayLabel } from '#lib/shared/workers/answer-path.ts';
import type {
	AttributeMoveImpact,
	CardinalitySurface,
	ConfigurationPreview,
	ConfigurationResolutions,
	RemovedAnswerHolder,
	RemovedAnswerImpact,
	WorkerAttributeDefinition
} from '#lib/domain-vocabulary.ts';
import { toWorkerAttributeDefinitions } from './attribute-draft.ts';
import type { AttributeDraft } from './attribute-draft.ts';

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
export function attributeMoveIsLossy(impact: AttributeMoveImpact): boolean {
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

export function workerCount(count: number): string {
	return m.configuration_count_workers({ count });
}

export function answerCount(count: number): string {
	return m.configuration_count_values({ count });
}

export function savedValueCount(count: number): string {
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
