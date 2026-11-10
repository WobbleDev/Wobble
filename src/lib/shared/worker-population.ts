/**
 * The shared reading of which Workers a set of filters selects (spec: Filtering,
 * hierarchy, and readings). Workers, Overview and Mapping read the same projection, so a
 * downstream breakdown cannot reintroduce a Worker the context excluded.
 *
 * The rules are the specification's:
 * - Every predicate is tested on the Worker itself.
 * - Several selected answers within one Attribute are alternatives (OR).
 * - An ordinary answer selection includes the selected answer and its descendants.
 * - An exact direct-parent selection (the expanded branch's remainder) matches the held
 *   answer itself and never its descendants.
 * - The no-answer reading matches either cardinality.
 */
import type { AttributeAnswer, Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { heldIdsOf } from '#lib/shared/select-mode.ts';

/** The filters that select a population. Every map holds selected answer ids by Attribute id. */
export type PopulationFilters = {
	/** Answer ids, OR within one Attribute. */
	answers?: ReadonlyMap<string, readonly string[]>;
	/** No-answer conditions by Attribute id. */
	missing?: ReadonlySet<string>;
	/**
	 * Direct-parent selections: the Worker holds exactly one of these answers, without the
	 * descendant inclusion an ordinary selection has. It is the exact remainder reading,
	 * never a subtree.
	 */
	exactAnswers?: ReadonlyMap<string, readonly string[]>;
};

/** What a population reading returns: the distinct matching Workers. */
export type PopulationProjection = {
	/** Distinct matching Workers, in the order they were given. */
	workers: Worker[];
};

type AttributeCondition = {
	attribute: WorkerAttributeDefinition;
	answerIds: readonly string[];
	missing: boolean;
};

/** An exact direct-parent condition: the held answer itself, never a descendant. */
type ExactCondition = {
	attribute: WorkerAttributeDefinition;
	answerIds: readonly string[];
};

/**
 * The answer ids a Worker holds for one Attribute, refusing values of the wrong shape.
 * Exported so a reading that counts holders (Configuration's outline) reads a Worker's
 * answers the same way the population projection does.
 */
export function heldAnswerIds(
	worker: Pick<Worker, 'attributes'>,
	attribute: WorkerAttributeDefinition
): string[] {
	// Either stored shape is the same set of held values (ADR 0043).
	return heldIdsOf(attribute, worker.attributes[attribute.id]);
}

const subtreeCache = new WeakMap<readonly AttributeAnswer[], Map<string, ReadonlySet<string>>>();

/**
 * The answer ids an ordinary selection of `ancestorId` includes: that answer and every
 * descendant, from the Attribute's current hierarchy. An id the Attribute no longer
 * offers selects nothing.
 */
function answersInSubtree(
	answers: readonly AttributeAnswer[],
	ancestorId: string
): ReadonlySet<string> {
	let byAncestor = subtreeCache.get(answers);
	if (!byAncestor) {
		byAncestor = new Map();
		subtreeCache.set(answers, byAncestor);
	}
	const cached = byAncestor.get(ancestorId);
	if (cached) return cached;

	const childrenByParent = new Map<string, string[]>();
	let known = false;
	for (const answer of answers) {
		if (answer.id === ancestorId) known = true;
		if (!answer.parentId) continue;
		const children = childrenByParent.get(answer.parentId);
		if (children) children.push(answer.id);
		else childrenByParent.set(answer.parentId, [answer.id]);
	}
	const subtree = new Set<string>();
	if (known) {
		const pending = [ancestorId];
		while (pending.length > 0) {
			const id = pending.pop() as string;
			if (subtree.has(id)) continue;
			subtree.add(id);
			pending.push(...(childrenByParent.get(id) ?? []));
		}
	}
	byAncestor.set(ancestorId, subtree);
	return subtree;
}

/**
 * Whether an answer a holder records lies in the selected answer's subtree. An
 * ordinary selection reads the selected answer and every descendant, which is the
 * membership an Overview group and the matching Worker cohort share.
 */
export function answerIsInSubtree(
	answers: readonly AttributeAnswer[],
	selectedAnswerId: string,
	heldAnswerId: string
): boolean {
	return answersInSubtree(answers, selectedAnswerId).has(heldAnswerId);
}

function holdsSelectedAnswer(
	attribute: WorkerAttributeDefinition,
	held: string,
	answerIds: readonly string[]
): boolean {
	if (held === '') return false;
	const selected = new Set(answerIds.flatMap((id) => [...answersInSubtree(attribute.answers, id)]));
	return selected.has(held);
}

function readConditions(
	attributes: readonly WorkerAttributeDefinition[],
	filters: PopulationFilters
): { conditions: AttributeCondition[]; exactConditions: ExactCondition[] } {
	const byId = new Map(attributes.map((attribute) => [attribute.id, attribute]));
	const conditions = new Map<string, AttributeCondition>();
	const exactConditions: ExactCondition[] = [];

	for (const [attributeId, answerIds] of filters.answers ?? []) {
		const attribute = byId.get(attributeId);
		if (!attribute || answerIds.length === 0) continue;
		conditions.set(attributeId, {
			attribute,
			answerIds,
			missing: conditions.get(attributeId)?.missing ?? false
		});
	}
	for (const attributeId of filters.missing ?? []) {
		const attribute = byId.get(attributeId);
		if (!attribute) continue;
		const current = conditions.get(attributeId);
		conditions.set(attributeId, {
			attribute,
			answerIds: current?.answerIds ?? [],
			missing: true
		});
	}
	for (const [attributeId, answerIds] of filters.exactAnswers ?? []) {
		const attribute = byId.get(attributeId);
		if (!attribute || answerIds.length === 0) continue;
		exactConditions.push({ attribute, answerIds });
	}

	return { conditions: [...conditions.values()], exactConditions };
}

/**
 * Whether a Worker satisfies one Attribute filter: a selected answer (including that
 * answer's descendants) or the no-answer reading, ORed together. This is the one Worker
 * predicate the Workers columns and the shared reading use.
 */
export function workerMatchesAnswerFilter(
	worker: Worker,
	attribute: WorkerAttributeDefinition,
	answerIds: readonly string[],
	missing = false
): boolean {
	if (answerIds.length === 0 && !missing) return true;
	const held = heldAnswerIds(worker, attribute);
	const answerMatches = held.some((id) => holdsSelectedAnswer(attribute, id, answerIds));
	const missingMatches = missing && held.length === 0;
	return answerMatches || missingMatches;
}

function workerMatches(worker: Worker, condition: AttributeCondition): boolean {
	return workerMatchesAnswerFilter(
		worker,
		condition.attribute,
		condition.answerIds,
		condition.missing
	);
}

/** Whether a Worker holds one of the exact answers, without including descendants. */
function workerHoldsExact(
	worker: Worker,
	attribute: WorkerAttributeDefinition,
	answerIds: readonly string[]
): boolean {
	return heldAnswerIds(worker, attribute).some((held) => answerIds.includes(held));
}

/** Selects the matching Workers once each, however many answers of one Attribute match. */
export function selectWorkerPopulation(
	workers: readonly Worker[],
	attributes: readonly WorkerAttributeDefinition[],
	filters: PopulationFilters = {}
): PopulationProjection {
	const { conditions, exactConditions } = readConditions(attributes, filters);
	const selectedWorkers: Worker[] = [];
	const seen = new Set<string>();

	for (const worker of workers) {
		if (seen.has(worker.id)) continue;
		seen.add(worker.id);
		if (!conditions.every((condition) => workerMatches(worker, condition))) continue;
		if (
			!exactConditions.every((condition) =>
				workerHoldsExact(worker, condition.attribute, condition.answerIds)
			)
		) {
			continue;
		}
		selectedWorkers.push(worker);
	}

	return { workers: selectedWorkers };
}

/** The saved-population reading of one Attribute, by answer id (Configuration's outline). */
export type AnswerPopulationCounts = {
	/** Distinct Workers holding this answer or a descendant. */
	workers: Map<string, number>;
	/** Distinct Workers holding this answer itself, never a descendant. */
	directWorkers: Map<string, number>;
	/** Distinct Workers holding at least one answer of this Attribute. */
	workersAnswering: number;
};

/** The ordinary (subtree-including) answer condition for one Attribute. */
function answerCondition(
	attribute: WorkerAttributeDefinition,
	answerId: string
): PopulationFilters {
	return { answers: new Map([[attribute.id, [answerId]]]) };
}

/** The exact direct-parent condition for one Attribute. */
function exactAnswerCondition(
	attribute: WorkerAttributeDefinition,
	answerId: string
): PopulationFilters {
	return { exactAnswers: new Map([[attribute.id, [answerId]]]) };
}

/**
 * Counts the holders of every answer in one Attribute from saved Worker data, using the
 * same population projection Workers, Overview and Mapping read. A parent includes its
 * descendants and each Worker once; the direct figure is the exact parent separately.
 */
export function countAnswerPopulation(
	workers: readonly Worker[],
	attribute: WorkerAttributeDefinition
): AnswerPopulationCounts {
	const counts: AnswerPopulationCounts = {
		workers: new Map(),
		directWorkers: new Map(),
		workersAnswering: 0
	};

	for (const answer of attribute.answers) {
		const subtree = selectWorkerPopulation(
			workers,
			[attribute],
			answerCondition(attribute, answer.id)
		);
		counts.workers.set(answer.id, subtree.workers.length);
		const direct = selectWorkerPopulation(
			workers,
			[attribute],
			exactAnswerCondition(attribute, answer.id)
		);
		counts.directWorkers.set(answer.id, direct.workers.length);
	}

	const defined = new Set(attribute.answers.map((answer) => answer.id));
	const countedWorkers = new Set<string>();

	for (const worker of workers) {
		const holdsAnswer = heldAnswerIds(worker, attribute).some((id) => defined.has(id));
		if (holdsAnswer && !countedWorkers.has(worker.id)) {
			countedWorkers.add(worker.id);
			counts.workersAnswering += 1;
		}
	}

	return counts;
}

/**
 * The saved holders of one of Configuration's value lists (Agitations or Languages), each
 * Worker counted once per value. Given the draft's entries, a folded entry's holders count
 * toward the value it folds into, and a value the draft no longer lists counts nowhere.
 */
export function countValueHolders(
	workers: readonly Worker[],
	kind: 'agitations' | 'languages',
	entries?: readonly { id: string; mergedInto?: string }[]
): { byId: Map<string, number>; workersWithAny: number } {
	const byId = new Map<string, number>();
	let workersWithAny = 0;
	const listed = entries && new Map(entries.map((entry) => [entry.id, entry]));
	const resolve = (id: string): string | null => {
		if (!listed) return id;
		const entry = listed.get(id);
		return entry ? (entry.mergedInto ?? entry.id) : null;
	};

	for (const worker of workers) {
		const held = new Set<string>();
		for (const id of worker[kind]) {
			if (typeof id !== 'string' || id === '') continue;
			const resolved = resolve(id);
			if (resolved !== null) held.add(resolved);
		}
		if (held.size === 0) continue;
		workersWithAny += 1;
		for (const id of held) byId.set(id, (byId.get(id) ?? 0) + 1);
	}

	return { byId, workersWithAny };
}
