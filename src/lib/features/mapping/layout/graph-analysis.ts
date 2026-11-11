/**
 * Reading the graph before it is drawn: bucket trees, a Worker's group values,
 * the degrees of an isolated neighbourhood, and which end of a tie an id is.
 */
import type { WorkerAttributeDefinition, WorkerAttributeValues } from '#lib/domain-vocabulary.ts';
import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
import { heldIds, heldIdsOf, storesList } from '#lib/shared/select-mode.ts';
import { m } from '#lib/paraglide/messages.js';
import type { WorkerGraphLink, WorkerGraphNode } from '../canvas/worker-relationship-map-model.ts';

export type WorkerGraph = {
	nodes: readonly WorkerGraphNode[];
	links: readonly WorkerGraphLink[];
};

export function buildAdjacency(graph: WorkerGraph): Map<string, Set<string>> {
	const adjacency = new Map<string, Set<string>>(
		graph.nodes.map((node) => [node.id, new Set<string>()])
	);

	for (const link of graph.links) {
		adjacency.get(link.source)?.add(link.target);
		adjacency.get(link.target)?.add(link.source);
	}

	return adjacency;
}

/**
 * The two degrees of a Worker's neighbourhood: their direct neighbours first,
 * then the neighbours of those. Ordered lists, so the partition is stable.
 */
export function isolatedDegrees(
	adjacency: Map<string, Set<string>>,
	rootId: string
): { firstDegree: string[]; secondDegree: string[] } {
	const firstDegree = [...(adjacency.get(rootId) ?? [])];
	const firstDegreeSet = new Set(firstDegree);
	const secondDegree = [
		...new Set(firstDegree.flatMap((id) => [...(adjacency.get(id) ?? [])]))
	].filter((id) => id !== rootId && !firstDegreeSet.has(id));

	return { firstDegree, secondDegree };
}

/**
 * The answer id a Worker holds for a Category, or `''` when it holds none. Grouping
 * and hidden values identify an answer by this id, never by its text.
 */
export function groupValue(
	node: Pick<WorkerGraphNode, 'attributes'>,
	attribute: WorkerAttributeDefinition | undefined
): string {
	if (!attribute) return '';

	const held = node.attributes?.[attribute.id];
	// The layout projects a Worker's value into one region id, whatever the Attribute's kind,
	// so a plain string names the group for either cardinality.
	if (typeof held === 'string') return held;
	return heldIdsOf(attribute, held)[0] ?? '';
}

/**
 * Maps a layout key to the text it stands for. Keys are answer ids, so the layout sorts
 * by this label to keep the order it had when keys were text.
 */
export type LabelOf = (key: string) => string;

/** The key as it stands: the label of a key that is already text. */
export const keyAsLabel: LabelOf = (key) => key;

/**
 * Orders layout keys by where the organizer put each answer in its Attribute's list, never
 * by the answer's id or its text, so neither a rename nor a freshly minted id can move a
 * group. No answer (`''`) comes first, as it did when keys were text; an id the Attribute
 * does not hold comes last. Layout seeds read these labels too, so the layout a view
 * reaches is a function of the answers' order alone.
 */
export function answerPositionLabel(attribute: WorkerAttributeDefinition | undefined): LabelOf {
	const positions = new Map(attribute?.answers.map((answer, index) => [answer.id, index]));
	return (key) => {
		if (key === '') return '';
		const position = positions.get(key);
		return position === undefined ? `~${key}` : String(position).padStart(8, '0');
	};
}

/** Code-unit order, which is what a bare `.sort()` on strings has always used. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The text an answer id shows as, looked up in the Attribute's own answers. `''` for
 * no answer, or for an id the Attribute does not hold.
 */
function answerText(attribute: WorkerAttributeDefinition, answerId: string): string {
	if (answerId === '') return '';
	return attribute.answers.find((answer) => answer.id === answerId)?.value ?? '';
}

/**
 * A Worker's answers to one Attribute as display text, read through their ids. A
 * Category gives one text and a Tag a list, the shapes `formatValue` already takes.
 * A label shared by another branch keeps its path, as everywhere else in the
 * interface, so the record never names two different answers the same way.
 */
export function answerDisplay(
	attribute: WorkerAttributeDefinition,
	values: WorkerAttributeValues | undefined
): string | string[] {
	const held = values?.[attribute.id];
	const display = (id: string): string =>
		attribute.answers.some((answer) => answer.id === id)
			? answerDisplayLabel(attribute.answers, id)
			: '';
	if (!storesList(attribute)) {
		return display(heldIds(held)[0] ?? '');
	}
	return heldIds(held)
		.map(display)
		.filter((text) => text !== '');
}

export type GraphBucket = {
	value: string;
	label: string;
	count: number;
};

export type GraphBucketTree = GraphBucket & {
	subGroups: GraphBucket[];
};

/**
 * A bucket holding the workers with no answer is still a bucket, and reads by the
 * shared no-value rule: No followed by the Attribute's current configured name.
 */
export function bucketLabel(value: string, attribute: WorkerAttributeDefinition): string {
	const configured = answerText(attribute, value);
	if (configured) return configured;

	// The localized no-answer reading; the collision description follows the text
	// that is actually displayed, so a renamed Attribute still reads correctly.
	return m.mapping_no_answer_attribute({ attribute: attribute.name });
}

/** The secondary description the no-value bucket adds when a real answer collides. */
function bucketDescription(value: string, attribute: WorkerAttributeDefinition): string {
	if (answerText(attribute, value)) return '';
	const label = m.mapping_no_answer_attribute({ attribute: attribute.name });
	return attribute.answers.some((answer) => answer.value === label) ? 'No selection' : '';
}

/** The bucket's full reading: the label, and the collision description when it has one. */
function bucketReading(value: string, attribute: WorkerAttributeDefinition): string {
	const label = bucketLabel(value, attribute);
	const description = bucketDescription(value, attribute);
	return description ? `${label} (${description})` : label;
}

/**
 * Partitions nodes by one attribute, and by a second nested inside it when one is
 * given. Buckets keep the order they were first seen in, and an absent answer
 * forms a bucket like any other value.
 */
export function buildBucketTree(
	nodes: readonly WorkerGraphNode[],
	groupAttribute: WorkerAttributeDefinition | undefined,
	subGroupAttribute: WorkerAttributeDefinition | undefined
): GraphBucketTree[] {
	if (!groupAttribute) return [];

	const groups = new Map<
		string,
		{ bucket: GraphBucketTree; subGroups: Map<string, GraphBucket> }
	>();

	for (const node of nodes) {
		const groupKey = groupValue(node, groupAttribute);
		let group = groups.get(groupKey);
		if (!group) {
			group = {
				bucket: {
					value: groupKey,
					label: bucketReading(groupKey, groupAttribute),
					count: 0,
					subGroups: []
				},
				subGroups: new Map()
			};
			groups.set(groupKey, group);
		}
		group.bucket.count += 1;

		if (!subGroupAttribute) continue;

		const childKey = groupValue(node, subGroupAttribute);
		const child = group.subGroups.get(childKey);
		if (child) {
			child.count += 1;
		} else {
			group.subGroups.set(childKey, {
				value: childKey,
				label: bucketReading(childKey, subGroupAttribute),
				count: 1
			});
		}
	}

	return [...groups.values()].map(({ bucket, subGroups }) => ({
		...bucket,
		subGroups: [...subGroups.values()]
	}));
}

export function linkEndId(end: unknown): string {
	if (typeof end === 'string') return end;
	if (typeof end === 'number') return String(end);
	if (typeof end === 'object' && end !== null && 'id' in end) {
		return String((end as { id: unknown }).id);
	}
	return '';
}
