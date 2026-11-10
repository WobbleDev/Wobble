/**
 * Moving an answer branch into another Attribute, or promoting a branch into a new
 * Attribute. Pure: nothing here mutates its inputs; every result is a fresh list of fresh
 * Attribute drafts, and a refusal names the reason in words the organizer can act on.
 */
import { m } from '#lib/paraglide/messages.js';
import {
	createAttribute,
	type AttributeAnswerDraft,
	type AttributeDraft
} from './attribute-draft.ts';
import {
	findDuplicateSiblingOption,
	getAttributeNameError,
	isAnswerInSubtree
} from './attribute-validation.ts';

/** The answer being moved or promoted, and the Attribute it is currently in. */
export type MoveSource = { attributeId: string; answerId: string };

/** Where the answer goes: an Attribute, and a parent in it (`''` is the top level). */
export type MoveTarget = { attributeId: string; parentId: string };

function findAttribute(attributes: readonly AttributeDraft[], id: string) {
	return attributes.find((attribute) => attribute.id === id);
}

/** An answer that still exists after Save: a folded one no longer names anything. */
function visibleAnswer(attribute: AttributeDraft | undefined, answerId: string) {
	return attribute?.answers.find((answer) => answer.id === answerId && !answer.mergedInto);
}

/** The root and all its descendants in this Attribute, in their original order. */
function branchOf(
	answers: readonly AttributeAnswerDraft[],
	rootId: string
): AttributeAnswerDraft[] {
	return answers.filter((answer) => isAnswerInSubtree(answers, answer.id, rootId));
}

/**
 * Whether a merge not yet saved touches the branch: a folded answer inside it, or a folded
 * answer outside it that points into it. Either way the merge plan would break if the
 * branch moved, so the move waits until the organizer resolves it.
 */
function hasPendingMerge(
	answers: readonly AttributeAnswerDraft[],
	branch: readonly AttributeAnswerDraft[]
) {
	const branchIds = new Set(branch.map((answer) => answer.id));
	return answers.some(
		(answer) =>
			Boolean(answer.mergedInto) &&
			(branchIds.has(answer.id) || branchIds.has(answer.mergedInto ?? ''))
	);
}

/** Why an answer cannot move under this parent of the same Attribute; empty when it can. */
function refusalWithin(
	attribute: AttributeDraft,
	root: AttributeAnswerDraft,
	parentId: string
): string {
	const parent = parentId || undefined;
	if (parent && !visibleAnswer(attribute, parent)) return m.configuration_move_parent_missing();
	if (parent && isAnswerInSubtree(attribute.answers, parent, root.id)) {
		return m.configuration_move_below_descendant();
	}
	if (parent === (root.parentId || undefined)) return m.configuration_move_refused_already_here();
	// A sibling label clash inside one Attribute is not refused: the move stays in the draft
	// and is renamed in place, as moveAttributeAnswer does.
	return '';
}

/** Why an answer branch cannot move into another Attribute under this parent; empty when it can. */
function refusalAcross(
	attributes: readonly AttributeDraft[],
	origin: AttributeDraft,
	root: AttributeAnswerDraft,
	target: MoveTarget
): string {
	const destination = findAttribute(attributes, target.attributeId);
	if (!destination) return m.configuration_move_refused_target_missing();

	const parent = target.parentId || undefined;
	if (parent && !visibleAnswer(destination, parent)) {
		return m.configuration_move_refused_target_missing();
	}
	if (hasPendingMerge(origin.answers, branchOf(origin.answers, root.id))) {
		return m.configuration_move_refused_pending_merge();
	}
	if (findDuplicateSiblingOption(destination, undefined, root.value, parent)) {
		return m.configuration_move_refused_name_conflict_target({ name: root.value.trim() });
	}
	return '';
}

/**
 * Why an answer cannot move to this target; empty when it can. Covers moves inside one
 * Attribute and moves into another one.
 */
export function moveRefusal(
	attributes: readonly AttributeDraft[],
	source: MoveSource,
	target: MoveTarget
): string {
	const origin = findAttribute(attributes, source.attributeId);
	const root = visibleAnswer(origin, source.answerId);
	if (!origin || !root) return m.configuration_move_refused_source_missing();

	return source.attributeId === target.attributeId
		? refusalWithin(origin, root, target.parentId)
		: refusalAcross(attributes, origin, root, target);
}

/** Why an answer cannot be promoted to an Attribute of its own; empty when it can. */
export function promoteRefusal(attributes: readonly AttributeDraft[], source: MoveSource): string {
	const origin = findAttribute(attributes, source.attributeId);
	const root = visibleAnswer(origin, source.answerId);
	if (!origin || !root) return m.configuration_move_refused_source_missing();

	const nameError = getAttributeNameError(root.value.trim(), attributes);
	if (nameError) return nameError;
	if (hasPendingMerge(origin.answers, branchOf(origin.answers, root.id))) {
		return m.configuration_move_refused_pending_merge();
	}
	return '';
}

/** Removes the given answers from one Attribute, clearing the errors a move leaves behind. */
function withoutAnswers(
	attribute: AttributeDraft,
	removedIds: ReadonlySet<string>
): AttributeDraft {
	return {
		...attribute,
		answers: attribute.answers.filter((answer) => !removedIds.has(answer.id)),
		moveError: '',
		removalError: ''
	};
}

/**
 * Moves an answer and its visible descendants into another Attribute, appended in their
 * original order. The root takes the target parent; ids and the rest of the branch stay
 * as they were. Returns null for a move inside one Attribute or a refused move.
 */
export function moveAnswerBranchToAttribute(
	attributes: readonly AttributeDraft[],
	source: MoveSource,
	target: MoveTarget
): AttributeDraft[] | null {
	if (source.attributeId === target.attributeId) return null;
	if (moveRefusal(attributes, source, target)) return null;
	const origin = findAttribute(attributes, source.attributeId);
	if (!origin) return null;

	const branch = branchOf(origin.answers, source.answerId);
	const branchIds = new Set(branch.map((answer) => answer.id));
	const parentId = target.parentId || undefined;
	const moved = branch.map((answer) =>
		answer.id === source.answerId ? { ...answer, parentId } : { ...answer }
	);

	return attributes.map((attribute) => {
		if (attribute.id === origin.id) return withoutAnswers(attribute, branchIds);
		if (attribute.id === target.attributeId) {
			return {
				...attribute,
				answers: [...attribute.answers, ...moved],
				moveError: '',
				removalError: ''
			};
		}
		return { ...attribute, answers: attribute.answers.map((answer) => ({ ...answer })) };
	});
}

/**
 * Turns an answer and its descendants into a new Attribute placed right after the one it
 * came from. The new Attribute takes the answer's id (the core reads a promotion by it) and
 * its label as the name; the root's direct children become top-level answers of it.
 * Returns null when the promotion is refused.
 */
export function promoteAnswerBranch(
	attributes: readonly AttributeDraft[],
	source: MoveSource
): AttributeDraft[] | null {
	if (promoteRefusal(attributes, source)) return null;
	const origin = findAttribute(attributes, source.attributeId);
	const root = visibleAnswer(origin, source.answerId);
	if (!origin || !root) return null;

	const branch = branchOf(origin.answers, root.id);
	const branchIds = new Set(branch.map((answer) => answer.id));
	const descendants = branch
		.filter((answer) => answer.id !== root.id)
		.map((answer) =>
			answer.parentId === root.id ? { ...answer, parentId: undefined } : { ...answer }
		);
	const promoted = createAttribute(root.id, root.value.trim(), origin.type, descendants);

	const updated = attributes.map((attribute) =>
		attribute.id === origin.id
			? withoutAnswers(attribute, branchIds)
			: { ...attribute, answers: attribute.answers.map((answer) => ({ ...answer })) }
	);
	const index = updated.findIndex((attribute) => attribute.id === origin.id);
	return [...updated.slice(0, index + 1), promoted, ...updated.slice(index + 1)];
}

function siblingIds(answers: readonly AttributeAnswerDraft[], answerId: string): string[] {
	const parentId = answers.find((answer) => answer.id === answerId)?.parentId || '';
	return answers
		.filter((answer) => !answer.mergedInto && (answer.parentId || '') === parentId)
		.map((answer) => answer.id);
}

/** A value's place among its visible siblings (one-based) and how many siblings it has. */
export function siblingPosition(
	answers: readonly AttributeAnswerDraft[],
	answerId: string
): { position: number; count: number } {
	const ids = siblingIds(answers, answerId);
	return { position: ids.indexOf(answerId) + 1, count: ids.length };
}

/**
 * Moves a value one place up or down among the siblings that share its parent (the top
 * level counts as one parent). Ids, parents, descendants, modes and holdings are untouched;
 * only the two siblings' places in the configured order change. Null at either end.
 */
export function moveAnswerAmongSiblings(
	answers: readonly AttributeAnswerDraft[],
	answerId: string,
	direction: -1 | 1
): AttributeAnswerDraft[] | null {
	const ids = siblingIds(answers, answerId);
	const neighbour = ids[ids.indexOf(answerId) + direction];
	if (ids.indexOf(answerId) < 0 || !neighbour) return null;
	const from = answers.findIndex((answer) => answer.id === answerId);
	const to = answers.findIndex((answer) => answer.id === neighbour);
	const moved = [...answers];
	[moved[from], moved[to]] = [moved[to], moved[from]];
	return moved;
}

/** Puts answers back in a recorded id order; any answer the record lacks keeps its relative place at the end. */
export function restoreAnswerOrder(
	answers: readonly AttributeAnswerDraft[],
	order: readonly string[]
): AttributeAnswerDraft[] {
	const rank = (id: string) => {
		const index = order.indexOf(id);
		return index < 0 ? order.length : index;
	};
	return [...answers].sort((a, b) => rank(a.id) - rank(b.id));
}

/** Which part of a row the pointer is over: the outer quarters place beside it, the middle nests. */
export function rowEdgeZone(y: number, top: number, height: number): 'before' | 'inside' | 'after' {
	if (height <= 0) return 'inside';
	const ratio = (y - top) / height;
	return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
}

/**
 * Puts a value directly before or after a sibling that shares its parent. Only the configured
 * order changes. Null when the two are not siblings or the value is already there.
 */
export function moveAnswerBesideSibling(
	answers: readonly AttributeAnswerDraft[],
	answerId: string,
	targetId: string,
	after: boolean
): AttributeAnswerDraft[] | null {
	const ids = siblingIds(answers, answerId);
	if (answerId === targetId || !ids.includes(targetId)) return null;
	const rest = answers.filter((answer) => answer.id !== answerId);
	const moving = answers.find((answer) => answer.id === answerId);
	if (!moving) return null;
	const at = rest.findIndex((answer) => answer.id === targetId);
	const next = [...rest.slice(0, after ? at + 1 : at), moving, ...rest.slice(after ? at + 1 : at)];
	return next.every((answer, index) => answer === answers[index]) ? null : next;
}
