/** The narrower filters, Groupings and Sub-groupings offered when a choice is unavailable. */
import { heldAnswerIds, selectWorkerPopulation } from '#lib/shared/workers/worker-population.ts';
import type {
	GroupingCell,
	PairedCell,
	NarrowingSuggestion,
	GroupingInput
} from './grouping-types.ts';
import {
	readCore,
	withCandidate,
	attributePosition,
	answerPosition,
	readSubCore
} from './grouping-core.ts';

/** The filter candidates worth offering beside a refusal, ranked and capped at three. */
function narrowingSuggestions(
	input: GroupingInput,
	ambiguous: ReadonlyMap<string, readonly string[]>,
	stillAmbiguous: (narrowed: GroupingInput) => ReadonlySet<string>
): NarrowingSuggestion[] {
	const candidates = new Map<string, { attributeId: string; answerId: string; missing: boolean }>();
	const add = (candidate: { attributeId: string; answerId: string; missing: boolean }) => {
		const key = `${candidate.attributeId}\u0001${candidate.missing ? 'missing' : 'answer'}\u0001${candidate.answerId}`;
		if (!candidates.has(key)) candidates.set(key, candidate);
	};

	// A narrowing condition can only name an answer a displayed Worker holds, or an
	// Attribute it holds no answer to: the shared projection keeps the Workers whose
	// reading still says so.
	for (const workerId of ambiguous.keys()) {
		const node = input.nodes.find(({ id }) => id === workerId);
		if (!node) continue;
		for (const attribute of input.attributes) {
			const held = heldAnswerIds(node, attribute);
			if (held.length === 0) {
				add({ attributeId: attribute.id, answerId: '', missing: true });
				continue;
			}
			for (const answerId of held) {
				if (!attribute.answers.some((answer) => answer.id === answerId)) continue;
				add({ attributeId: attribute.id, answerId, missing: false });
			}
		}
	}

	const displayed = new Set(input.nodes.map(({ id }) => id));
	const suggestions: NarrowingSuggestion[] = [];

	for (const candidate of candidates.values()) {
		const projection = selectWorkerPopulation(
			input.workers,
			input.attributes,
			withCandidate(input.filters, candidate)
		);
		const layoutIds = new Set(
			projection.workers.map(({ id }) => id).filter((id) => displayed.has(id))
		);
		const narrowed = { ...input, nodes: input.nodes.filter(({ id }) => layoutIds.has(id)) };
		const still = stillAmbiguous(narrowed);
		const resolves = [...ambiguous.keys()].filter((id) => !still.has(id)).length;
		if (resolves === 0) continue;
		suggestions.push({
			attributeId: candidate.attributeId,
			answerIds: [candidate.answerId],
			missing: candidate.missing,
			resolves
		});
	}

	return suggestions
		.sort(
			(first, second) =>
				second.resolves - first.resolves ||
				attributePosition(input.attributes, first.attributeId) -
					attributePosition(input.attributes, second.attributeId) ||
				answerPosition(input.attributes, first) - answerPosition(input.attributes, second) ||
				first.answerIds[0].localeCompare(second.answerIds[0])
		)
		.slice(0, 3);
}

/** The filters that would let the primary Grouping place the ambiguous Workers. */
export function groupingSuggestions(
	input: GroupingInput,
	attributeId: string,
	ambiguous: ReadonlyMap<string, GroupingCell[]>,
	expandedIds: Iterable<string>
): NarrowingSuggestion[] {
	return narrowingSuggestions(
		input,
		new Map([...ambiguous].map(([workerId, cells]) => [workerId, cells.map(({ group }) => group)])),
		(narrowed) => {
			const reading = readCore(narrowed, attributeId, expandedIds);
			return reading.status === 'available' ? new Set() : new Set(reading.ambiguous.keys());
		}
	);
}

/** The filters that would let the paired Sub-grouping place the ambiguous Workers. */
export function subGroupingSuggestions(
	input: GroupingInput,
	primaryAttributeId: string,
	subAttributeId: string,
	pairs: ReadonlyMap<string, PairedCell[]>,
	expandedIds: Iterable<string>,
	expandedSubIds: Iterable<string>
): NarrowingSuggestion[] {
	// Only a Worker with more than one pair is ambiguous; the rest need no guidance.
	const ambiguous = new Map([...pairs].filter(([, entries]) => entries.length !== 1));
	return narrowingSuggestions(
		input,
		new Map([...ambiguous].map(([workerId, entries]) => [workerId, entries.map(([, sub]) => sub)])),
		(narrowed) => {
			const reading = readCore(narrowed, primaryAttributeId, expandedIds);
			if (reading.status !== 'available') return new Set(ambiguous.keys());
			const sub = readSubCore(
				narrowed,
				reading,
				primaryAttributeId,
				subAttributeId,
				expandedSubIds
			);
			if (sub.status === 'available') return new Set();
			return sub.reason.code === 'paired-regions-differ'
				? new Set(sub.reason.workers.map(({ workerId }) => workerId))
				: new Set(sub.reason.workerIds);
		}
	);
}
