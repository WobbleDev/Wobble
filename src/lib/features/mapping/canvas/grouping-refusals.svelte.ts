/**
 * Why a Grouping or a Sub-grouping cannot draw: the refusal its reading carries, in words,
 * and the narrowing filters offered beside it. The toolbar renders them; this owns the
 * wording, so the two readings answer in one voice and can be specced on their own.
 */
import { m } from '#lib/paraglide/messages.js';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { answerDisplayLabel } from '#lib/shared/workers/answer-path.ts';
import { noValueReading } from '#lib/shared/text/no-value-reading.ts';
import { regionReading } from '../grouping/grouping-cells.ts';
import type { ExpansionRefusal, GroupingReading } from '../grouping/grouping-types.ts';
import type { MapViewState } from '../map-view-state.svelte.ts';

/** What the refusals read from the toolbar. */
export type GroupingRefusalsHost = {
	/** The active reading: the chosen Grouping and, inside it, the chosen Sub-grouping. */
	reading: () => GroupingReading | undefined;
	view: () => MapViewState;
	workerNames: () => ReadonlyMap<string, string>;
	attributeById: () => ReadonlyMap<string, WorkerAttributeDefinition>;
};

export function createGroupingRefusals(host: GroupingRefusalsHost) {
	/** The chosen Grouping's refusal, when it has one; the status explains it. */
	const groupingRefusal = $derived.by(() => {
		const reading = host.reading();
		return reading?.status === 'unavailable' ? reading : undefined;
	});
	const groupingAttribute = $derived(host.view().groupingAttribute);

	/** The refusal in words: which Workers hold more than one region, or which ids are gone. */
	const groupingReason = $derived.by(() => {
		const reading = groupingRefusal;
		const attribute = groupingAttribute;
		if (!reading || !attribute) return '';
		if (reading.reason.code === 'multiple-regions') {
			const workers = reading.reason.workers
				.map(
					({ workerId, keys }) =>
						`${host.workerNames().get(workerId) ?? workerId} (${keys
							.map((key) => regionReading(attribute, key).label)
							.join(', ')})`
				)
				.join('; ');
			return m.mapping_group_reason_multiple_regions({ attribute: attribute.name, workers });
		}
		// The active reading never carries an expansion refusal; the control explains a
		// refused attempt through the same words if it ever did.
		if (reading.reason.code === 'expansion-breaks-partition') {
			return expansionRefusalText(reading.reason, attribute, host.workerNames());
		}
		return m.mapping_group_reason_unresolved({
			attribute: attribute.name,
			answers: reading.reason.answerIds.join(', ')
		});
	});

	/** The checked narrowing filters offered beside the refusal. */
	const groupingSuggestions = $derived.by(() => {
		const reading = groupingRefusal;
		if (!reading) return [];
		return reading.suggestions.flatMap((suggestion) => {
			const attribute = host.attributeById().get(suggestion.attributeId);
			if (!attribute) return [];
			const answer = suggestion.missing
				? noValueReading(attribute).label
				: answerDisplayLabel(attribute.answers, suggestion.answerIds[0] ?? '');
			return [
				{
					key: `${suggestion.attributeId}:${suggestion.missing ? 'missing' : suggestion.answerIds[0]}`,
					label: m.mapping_group_suggestion({ attribute: attribute.name, answers: answer })
				}
			];
		});
	});

	/** The chosen Sub-grouping's refusal, when the primary stays grouped but pairing cannot. */
	const subGroupingRefusal = $derived.by(() => {
		const reading = host.reading();
		if (reading?.status !== 'available') return undefined;
		return reading.subGrouping?.status === 'unavailable' ? reading.subGrouping : undefined;
	});
	const subGroupingAttribute = $derived(host.view().subGroupingAttribute);

	/** The pairing refusal in words: each Worker's pairs, read by both questions. */
	const subGroupingReason = $derived.by(() => {
		const reading = subGroupingRefusal;
		const primary = groupingAttribute;
		const secondary = subGroupingAttribute;
		if (!reading || !primary || !secondary) return '';
		if (reading.reason.code === 'paired-regions-differ') {
			const workers = reading.reason.workers
				.map(({ workerId, pairs }) => {
					const pairText = pairs
						.map(
							([group, subGroup]) =>
								`${regionReading(primary, group).label} / ${
									regionReading(secondary, subGroup).label
								}`
						)
						.join(', ');
					return `${host.workerNames().get(workerId) ?? workerId} (${pairText})`;
				})
				.join('; ');
			return m.mapping_sub_group_reason_paired_regions({
				subAttribute: secondary.name,
				workers
			});
		}
		return m.mapping_group_reason_unresolved({
			attribute: secondary.name,
			answers: reading.reason.answerIds.join(', ')
		});
	});

	/** The checked narrowing filters offered beside a pairing refusal. */
	const subGroupingSuggestions = $derived.by(() => {
		const reading = subGroupingRefusal;
		if (!reading) return [];
		return reading.suggestions.flatMap((suggestion) => {
			const attribute = host.attributeById().get(suggestion.attributeId);
			if (!attribute) return [];
			const answer = suggestion.missing
				? noValueReading(attribute).label
				: answerDisplayLabel(attribute.answers, suggestion.answerIds[0] ?? '');
			return [
				{
					key: `sub:${suggestion.attributeId}:${suggestion.missing ? 'missing' : suggestion.answerIds[0]}`,
					label: m.mapping_group_suggestion({ attribute: attribute.name, answers: answer })
				}
			];
		});
	});

	return {
		get groupingRefusal() {
			return groupingRefusal;
		},
		get groupingAttribute() {
			return groupingAttribute;
		},
		get groupingReason() {
			return groupingReason;
		},
		get groupingSuggestions() {
			return groupingSuggestions;
		},
		get subGroupingRefusal() {
			return subGroupingRefusal;
		},
		get subGroupingAttribute() {
			return subGroupingAttribute;
		},
		get subGroupingReason() {
			return subGroupingReason;
		},
		get subGroupingSuggestions() {
			return subGroupingSuggestions;
		}
	};
}

/** A refused branch expansion in words: the Workers it would split across regions. */
export function expansionRefusalText(
	reading: ExpansionRefusal | null,
	attribute: WorkerAttributeDefinition | undefined,
	workerNames: ReadonlyMap<string, string>
): string {
	if (!reading || !attribute) return '';
	const workers = reading.workers
		.map(
			({ workerId, keys }) =>
				`${workerNames.get(workerId) ?? workerId} (${keys
					.map((key) => regionReading(attribute, key).label)
					.join(', ')})`
		)
		.join('; ');
	return m.mapping_expansion_refused({
		answer: regionReading(attribute, reading.branchId).label,
		workers
	});
}
