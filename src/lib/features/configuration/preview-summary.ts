/**
 * The Configuration preview's report: the summary rows and sentence that describe what a
 * Save would change, resolving the current labels for the report's ids. Pure.
 */
import { m } from '#lib/paraglide/messages.js';
import { answerDisplayLabel } from '#lib/shared/workers/answer-path.ts';
import type {
	Agitation,
	ConfigurationPreview,
	ConfigurationPreviewTotals,
	Language,
	RemovedAnswerImpact,
	WorkerAttributeDefinition,
	WorkerAttributeKind
} from '#lib/domain-vocabulary.ts';
import { attributeTypeLabel, toWorkerAttributeDefinitions } from './attribute-draft.ts';
import type { ValueEntry } from './configuration-draft.ts';
import type { AttributeDraft } from './attribute-draft.ts';
import {
	attributeMoveIsLossy,
	workerCount,
	answerCount,
	savedValueCount
} from './preview-resolutions.ts';

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
