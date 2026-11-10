/**
 * The shared hierarchy frontier (spec: Filtering, hierarchy, and readings).
 *
 * Readings start broadly: every Attribute is read at its root answers, and each
 * root's region includes that root and every descendant. Expanding one branch
 * replaces its broad region with the branch's direct children (each still
 * including its own descendants) followed by an occupied direct-parent
 * remainder. The remainder is the exact reading of Workers who hold the parent
 * itself — not the parent's subtree — and is labelled as further detail unknown.
 *
 * The frontier and the remainder identity are shared vocabulary, not Overview's
 * private reading: Mapping expands the same branches at the same detail (ticket
 * 24) and must not derive a different remainder meaning.
 *
 * Identity rules (ADR 0030): a configured answer is identified by its
 * id, and the exact remainder uses a system identity that can never be a
 * configured answer id. Answer ids and Attribute ids never contain a colon, so
 * '#self:<attributeId>:<answerId>' is unambiguous.
 */
import type { AttributeAnswer, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
import { m } from '#lib/paraglide/messages.js';

/** The prefix that makes a direct-parent remainder a system identity. */
const REMAINDER_PREFIX = '#self:';

/**
 * One region of a reading at the current detail.
 *
 * - An answer region is a configured answer; unless it is expanded it includes
 *   that answer and every descendant.
 * - A remainder region is the exact reading of the parent itself, shown after
 *   the parent's children while the parent is expanded.
 */
export type HierarchyRegion = {
	/** The typed identity: the answer id, or the remainder system identity. */
	identity: string;
	/** The configured answer this region is about, for both kinds. */
	answerId: string;
	kind: 'answer' | 'remainder';
	/** How the region is named, with a path only where labels collide. */
	label: string;
	/** The secondary text a system region adds; null for an ordinary answer. */
	description: string | null;
	/** Root regions are 0; a branch's children are one deeper. */
	depth: number;
	/** True when this answer has children, so the region can offer expansion. */
	expandable: boolean;
	/** True when the region is a remainder of an expanded branch. */
	expanded: boolean;
};

export type HierarchyFrontier = {
	/** Regions in configured order: pre-order children, then the branch remainder. */
	regions: HierarchyRegion[];
	/** Every answer id in the Attribute that has at least one child. */
	expandable: ReadonlySet<string>;
};

function answersById(attribute: WorkerAttributeDefinition): Map<string, AttributeAnswer> {
	return new Map(attribute.answers.map((answer) => [answer.id, answer]));
}

/** Direct children by parent, in configured order; parents appear once. */
function childrenByParent(attribute: WorkerAttributeDefinition): Map<string, AttributeAnswer[]> {
	const children = new Map<string, AttributeAnswer[]>();
	for (const answer of attribute.answers) {
		if (!answer.parentId) continue;
		const siblings = children.get(answer.parentId);
		if (siblings) siblings.push(answer);
		else children.set(answer.parentId, [answer]);
	}
	return children;
}

function hasChildren(attribute: WorkerAttributeDefinition): Set<string> {
	return new Set(
		attribute.answers
			.map((answer) => answer.parentId)
			.filter((parentId): parentId is string => typeof parentId === 'string' && parentId !== '')
	);
}

/**
 * The expansion ids the current configuration can honour: answers that exist,
 * have at least one child, and whose whole ancestor chain is expanded too. A
 * leaf, a removed answer, a foreign id or a reparented branch drops silently;
 * duplicates collapse. The result is in configured order so equal views write
 * equal addresses.
 */
export function normalizeExpansion(
	attribute: WorkerAttributeDefinition,
	expandedIds: Iterable<string>
): string[] {
	const byId = answersById(attribute);
	const parents = hasChildren(attribute);
	const accepted = new Set<string>();

	for (const raw of expandedIds) {
		if (typeof raw !== 'string' || !parents.has(raw)) continue;
		let current = byId.get(raw);
		let guard = 0;
		while (current && guard <= attribute.answers.length) {
			guard += 1;
			if (parents.has(current.id)) accepted.add(current.id);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
	}

	return attribute.answers.filter((answer) => accepted.has(answer.id)).map((answer) => answer.id);
}

/** Every answer id in the branch under (and including) `answerId`. */
export function branchAnswerIds(
	attribute: WorkerAttributeDefinition,
	answerId: string
): ReadonlySet<string> {
	const children = childrenByParent(attribute);
	const branch = new Set<string>();
	const pending = [answerId];
	while (pending.length > 0) {
		const id = pending.pop() as string;
		if (branch.has(id)) continue;
		branch.add(id);
		for (const child of children.get(id) ?? []) pending.push(child.id);
	}
	return branch;
}

/** Expands one branch, adding the ancestors it needs. */
export function expandBranch(
	attribute: WorkerAttributeDefinition,
	expandedIds: Iterable<string>,
	answerId: string
): string[] {
	return normalizeExpansion(attribute, [...expandedIds, answerId]);
}

/**
 * Collapses one branch, dropping the branch itself and everything expanded
 * below it — collapsing a parent must not leave a deeper detail hidden behind
 * it, and normalization would otherwise re-add the parent for those children.
 */
export function collapseBranch(
	attribute: WorkerAttributeDefinition,
	expandedIds: Iterable<string>,
	answerId: string
): string[] {
	const branch = branchAnswerIds(attribute, answerId);
	return normalizeExpansion(
		attribute,
		[...expandedIds].filter((id) => !branch.has(id))
	);
}

/**
 * The reading at the current detail. Unexpanded answers stay one broad region
 * that includes their descendants; an expanded answer is replaced by its direct
 * children (pre-order) and then its remainder. Leaves are never offered a
 * fabricated child level.
 */
export function frontier(
	attribute: WorkerAttributeDefinition,
	expandedIds: Iterable<string>
): HierarchyFrontier {
	const byId = answersById(attribute);
	const children = childrenByParent(attribute);
	const expandable = hasChildren(attribute);
	const normalized = new Set(normalizeExpansion(attribute, expandedIds));
	const regions: HierarchyRegion[] = [];
	const visited = new Set<string>();

	function emit(answer: AttributeAnswer, depth: number): void {
		if (visited.has(answer.id)) return;
		visited.add(answer.id);
		const kids = children.get(answer.id) ?? [];
		if (kids.length > 0 && normalized.has(answer.id)) {
			for (const child of kids) emit(child, depth + 1);
			regions.push({
				identity: remainderIdentity(attribute.id, answer.id),
				answerId: answer.id,
				kind: 'remainder',
				label: answerDisplayLabel(attribute.answers, answer.id),
				description: m.overview_hierarchy_group_only(),
				depth,
				expandable: true,
				expanded: true
			});
			return;
		}
		regions.push({
			identity: answer.id,
			answerId: answer.id,
			kind: 'answer',
			label: answerDisplayLabel(attribute.answers, answer.id),
			description: null,
			depth,
			expandable: kids.length > 0,
			expanded: false
		});
	}

	for (const answer of attribute.answers) {
		if (answer.parentId && byId.has(answer.parentId)) continue;
		emit(answer, 0);
	}

	return { regions, expandable };
}

/** The exact direct-parent system identity for one branch. */
export function remainderIdentity(attributeId: string, answerId: string): string {
	return `${REMAINDER_PREFIX}${attributeId}:${answerId}`;
}

/** Whether a value is a direct-parent remainder identity, never an answer id. */
export function isRemainderIdentity(identity: string): boolean {
	return identity.startsWith(REMAINDER_PREFIX);
}

/** Reads a remainder identity back into its Attribute and answer. */
export function parseRemainderIdentity(
	identity: string
): { attributeId: string; answerId: string } | null {
	if (!isRemainderIdentity(identity)) return null;
	const rest = identity.slice(REMAINDER_PREFIX.length);
	const separator = rest.indexOf(':');
	if (separator <= 0) return null;
	const attributeId = rest.slice(0, separator);
	const answerId = rest.slice(separator + 1);
	if (!attributeId || !answerId) return null;
	return { attributeId, answerId };
}

/**
 * Whether a region identity is the system's rather than a configured answer's.
 * The empty string is the Worker-level no-answer reading; every system group
 * begins with '#'. Configured ids never begin with it (ADR 0030), so a real
 * answer cannot impersonate a system region.
 */
export function isSystemRegionIdentity(identity: string): boolean {
	return identity === '' || identity.startsWith('#');
}

/** The further-detail-unknown reading of one exact remainder. */
export function remainderReading(
	attribute: WorkerAttributeDefinition,
	answerId: string
): { label: string; description: string } {
	return {
		label: answerDisplayLabel(attribute.answers, answerId),
		description: m.overview_hierarchy_group_only()
	};
}
