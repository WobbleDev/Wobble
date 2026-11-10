/**
 * Per-value select modes (ADR 0043), mirroring the core's `select_mode` module. A group is
 * the sub-values of one answer, or an Attribute's top-level answers. The Attribute's kind
 * governs the top level (`category` is Single-Select, `tag` is Multi-Select); an answer with
 * sub-values carries its own `mode`, or follows the Attribute's kind when it has none. A
 * Single-Select group lets a Worker hold values from at most one of its branches.
 */
import type {
	AttributeAnswer,
	SelectMode,
	WorkerAttributeKind,
	WorkerAttributeValue
} from '#lib/domain-vocabulary.ts';

type ModeSubject = { kind: WorkerAttributeKind; answers: readonly AttributeAnswer[] };

/** The mode an Attribute kind gives its top level and its unmoded answers. */
export function kindMode(kind: WorkerAttributeKind): SelectMode {
	return kind === 'tag' ? 'multi' : 'single';
}

/** Whether an answer has sub-values among the given (kept) answers. */
function answerHasChildren(answers: readonly AttributeAnswer[], answerId: string): boolean {
	return answers.some((answer) => answer.parentId === answerId);
}

/** The mode governing the sub-values of `answerId`, or the top level when it is `undefined`. */
export function groupMode(subject: ModeSubject, answerId?: string): SelectMode {
	if (answerId === undefined) return kindMode(subject.kind);
	return subject.answers.find((answer) => answer.id === answerId)?.mode ?? kindMode(subject.kind);
}

/** Whether a Single-Select Attribute stores a list: some answer with sub-values is Multi-Select. */
export function storesList(subject: ModeSubject): boolean {
	if (subject.kind === 'tag') return true;
	return subject.answers.some(
		(answer) => answer.mode === 'multi' && answerHasChildren(subject.answers, answer.id)
	);
}

/** Whether a Worker can hold several values of the Attribute at some level of it. */
export function canHoldSeveral(subject: ModeSubject): boolean {
	return storesList(subject);
}

/** The answer ids a stored value holds, whatever its shape. */
export function heldIds(value: WorkerAttributeValue | undefined | null): string[] {
	if (typeof value === 'string') return value === '' ? [] : [value];
	if (!Array.isArray(value)) return [];
	return value.filter((id): id is string => typeof id === 'string' && id !== '');
}

/** The answer ids as the Attribute stores them: a string unless it stores a list. */
export function shapeValue(subject: ModeSubject, ids: readonly string[]): WorkerAttributeValue {
	return storesList(subject) ? [...ids] : (ids[0] ?? '');
}

/**
 * The answer ids an Attribute's stored value holds, refusing a shape the Attribute does not
 * store: a Multi-Select Attribute holds a list, a Single-Select one a string, and a
 * Single-Select Attribute with a Multi-Select group may hold either.
 */
export function heldIdsOf(
	subject: ModeSubject,
	value: WorkerAttributeValue | undefined | null
): string[] {
	if (typeof value === 'string') return subject.kind === 'category' ? heldIds(value) : [];
	if (Array.isArray(value)) return storesList(subject) ? heldIds(value) : [];
	return [];
}

function childrenByParent(answers: readonly AttributeAnswer[]): Map<string | undefined, string[]> {
	const children = new Map<string | undefined, string[]>();
	for (const answer of answers) {
		const siblings = children.get(answer.parentId);
		if (siblings) siblings.push(answer.id);
		else children.set(answer.parentId, [answer.id]);
	}
	return children;
}

function subtreeIds(children: Map<string | undefined, string[]>, rootId: string): Set<string> {
	const ids = new Set<string>();
	const pending = [rootId];
	while (pending.length > 0) {
		const id = pending.pop() as string;
		ids.add(id);
		pending.push(...(children.get(id) ?? []));
	}
	return ids;
}

/**
 * Splits held ids into those a Worker keeps and those the group modes drop: in each
 * Single-Select group the first branch in answer order that holds anything stays, together
 * with the group's own parent if held; held ids in other branches go.
 */
export function enforceModes(
	subject: ModeSubject,
	ids: readonly string[]
): { kept: string[]; dropped: string[] } {
	const children = childrenByParent(subject.answers);
	const known = new Set(subject.answers.map((answer) => answer.id));
	const kept = new Set(ids.filter((id) => known.has(id)));
	const dropped = new Set<string>();
	const groups: (string | undefined)[] = [undefined];
	while (groups.length > 0) {
		const parent = groups.pop();
		const branches = children.get(parent) ?? [];
		if (groupMode(subject, parent) === 'single') {
			let keeperSeen = false;
			for (const branch of branches) {
				const held = [...subtreeIds(children, branch)].filter((id) => kept.has(id));
				if (held.length === 0) continue;
				if (keeperSeen) {
					for (const id of held) {
						kept.delete(id);
						dropped.add(id);
					}
				} else {
					keeperSeen = true;
				}
			}
		}
		for (const branch of branches) if (children.has(branch)) groups.push(branch);
	}
	return {
		kept: ids.filter((id) => !dropped.has(id)),
		dropped: ids.filter((id) => dropped.has(id))
	};
}

/** What a Worker keeps: the modes' keepers for a list Attribute, the first for a single id. */
export function resolveIds(
	subject: ModeSubject,
	ids: readonly string[]
): { kept: string[]; dropped: string[] } {
	const { kept, dropped } = enforceModes(subject, ids);
	if (!storesList(subject) && kept.length > 1) {
		return { kept: kept.slice(0, 1), dropped: [...dropped, ...kept.slice(1)] };
	}
	return { kept, dropped };
}

/**
 * The ids held after the organizer picks `answerId`: it joins the set, and in every
 * Single-Select group on its path the other branches' held ids leave. Picking an answer that
 * is already held removes it (its descendants stay unless the caller clears them).
 */
export function pickAnswer(
	subject: ModeSubject,
	held: readonly string[],
	answerId: string
): string[] {
	if (held.includes(answerId)) return held.filter((id) => id !== answerId);
	const children = childrenByParent(subject.answers);
	const byId = new Map(subject.answers.map((answer) => [answer.id, answer]));
	const next = new Set(held);
	next.add(answerId);
	let current: string | undefined = answerId;
	while (current !== undefined) {
		const parent: string | undefined = byId.get(current)?.parentId;
		if (groupMode(subject, parent) === 'single') {
			for (const sibling of children.get(parent) ?? []) {
				if (sibling === current) continue;
				for (const id of subtreeIds(children, sibling)) next.delete(id);
			}
		}
		current = parent;
	}
	// Keep the recorded order for ids that stay, then the new pick last.
	return [...held.filter((id) => next.has(id)), answerId];
}

/**
 * The ids a multi-choice control saves after the organizer changed it from `held` to `next`:
 * a newly added id goes through the group modes, so choosing a branch of a Single-Select
 * group replaces the group's other branches; a removal is taken as it is.
 */
export function applyChange(
	subject: ModeSubject,
	held: readonly string[],
	next: readonly string[]
): string[] {
	const added = next.find((id) => !held.includes(id));
	return added === undefined ? [...next] : pickAnswer(subject, held, added);
}
