import { tick } from 'svelte';
import { m } from '#lib/paraglide/messages.js';
import { answerPathLabel } from '#lib/shared/answer-path.ts';
import type { AttributeDraft } from './attribute-draft.ts';
import { visibleValues } from './configuration-draft.ts';
import { isAnswerInSubtree } from './attribute-validation.ts';
import {
	moveRefusal,
	rowEdgeZone,
	promoteRefusal,
	siblingPosition,
	type MoveSource,
	type MoveTarget
} from './attribute-moves.ts';

/**
 * Where a placement can land: an answer or Attribute row (`parentId` is '' for the top level
 * of an Attribute), or the promote zone, which names no Attribute and sets `promote`.
 */
export type PlacementTarget = { attributeId: string; parentId: string; promote?: boolean };
export type PlacementSource =
	| { kind: 'answer'; attributeId: string; answerId: string }
	| { kind: 'pending'; attributeId: string; value: string };
/** The target the pointer or focus rests on while it refuses the placement, and why. */
export type PlacementRefusal = { target: PlacementTarget; reason: string };
type Source = PlacementSource;
type Host = {
	attributes: readonly AttributeDraft[];
	root: HTMLElement | null;
	disabled: boolean;
	expandedIds: ReadonlySet<string>;
	expand: (id: string) => void;
	move: (attributeId: string, answerId: string, parentId: string) => void;
	moveToAttribute: (source: MoveSource, target: MoveTarget) => boolean;
	promote: (source: MoveSource) => boolean;
	/** Puts the value before or after a sibling in the draft; false when nothing changes. */
	reorderBeside: (
		attributeId: string,
		answerId: string,
		targetId: string,
		after: boolean
	) => boolean;
	create: (attributeId: string, value: string, parentId: string) => string | null;
};

const EXPANSION_DELAY_MS = 500;
const SCROLL_EDGE_PX = 44;
const SCROLL_STEP_PX = 12;

function targetKey(target: PlacementTarget): string {
	return JSON.stringify([target.attributeId, target.parentId, Boolean(target.promote)]);
}
function sameTarget(a: PlacementTarget | null, b: PlacementTarget | null): boolean {
	return a === null || b === null ? a === b : targetKey(a) === targetKey(b);
}
function sameRefusal(a: PlacementRefusal | null, b: PlacementRefusal | null): boolean {
	return a === null || b === null
		? a === b
		: a.reason === b.reason && sameTarget(a.target, b.target);
}

/** One draft placement session shared by pointer, click and keyboard input. */
export function createAttributePlacement(host: Host) {
	let source = $state<Source | null>(null);
	let destination = $state<PlacementTarget | null>(null);
	let refusal = $state.raw<PlacementRefusal | null>(null);
	let announcement = $state('');
	let armed = $state.raw<{ event: PointerEvent; handle: HTMLElement; source: Source } | null>(null);
	let dragging = $state(false);
	let reorderDrop = $state<{ targetId: string; after: boolean } | null>(null);
	let dragPreview = $state<{ x: number; y: number } | null>(null);
	let suppressClick = false;
	let suppressionTimer: ReturnType<typeof setTimeout> | undefined;
	let expansionTimer: ReturnType<typeof setTimeout> | undefined;
	let autoScrollTimer: ReturnType<typeof setInterval> | undefined;
	let pointerPosition: { x: number; y: number } | null = null;
	function clearClickSuppression() {
		clearTimeout(suppressionTimer);
		suppressionTimer = undefined;
		suppressClick = false;
	}
	function suppressNextClick() {
		suppressClick = true;
		clearTimeout(suppressionTimer);
		suppressionTimer = setTimeout(() => {
			suppressClick = false;
			suppressionTimer = undefined;
		}, 500);
	}
	function consumeSuppressedClick(event: MouseEvent) {
		if (!suppressClick) return;
		clearClickSuppression();
		event.preventDefault();
		event.stopImmediatePropagation();
	}
	let detach = () => {};
	let focusTimer: ReturnType<typeof setTimeout> | undefined;

	function attributeNamed(id: string) {
		return host.attributes.find((item) => item.id === id);
	}
	function attribute() {
		return attributeNamed(source?.attributeId ?? '');
	}
	function label() {
		const item = attribute();
		if (!item || !source) return '';
		return source.kind === 'pending'
			? source.value
			: answerPathLabel(visibleValues(item.answers), source.answerId);
	}
	/**
	 * Why this target cannot take the placement in progress; empty when it can, or when no
	 * placement is in progress. Same-Attribute answer targets keep their existing rules: a
	 * visible parent outside the moved branch, or the top level.
	 */
	function refusalFor(target: PlacementTarget): string {
		const current = source;
		const item = attribute();
		if (!current || !item || host.disabled) return '';
		if (current.kind === 'pending') {
			if (target.promote || target.attributeId !== item.id) {
				return m.configuration_placement_refusal_pending_elsewhere();
			}
			return current.value.trim() ? '' : m.configuration_placement_refusal_empty();
		}
		const origin = { attributeId: current.attributeId, answerId: current.answerId };
		if (target.promote) return promoteRefusal(host.attributes, origin);
		if (target.attributeId !== item.id) {
			return moveRefusal(host.attributes, origin, {
				attributeId: target.attributeId,
				parentId: target.parentId
			});
		}
		const answers = visibleValues(item.answers);
		if (!answers.some((answer) => answer.id === current.answerId)) {
			return m.configuration_move_refused_source_missing();
		}
		if (target.parentId && !answers.some((answer) => answer.id === target.parentId)) {
			return m.configuration_move_parent_missing();
		}
		if (target.parentId && isAnswerInSubtree(answers, target.parentId, current.answerId)) {
			return m.configuration_move_below_descendant();
		}
		return '';
	}
	function eligible(target: PlacementTarget): boolean {
		return Boolean(source && attribute() && !host.disabled) && refusalFor(target) === '';
	}
	function focusSource(current: Source | null, handle = true) {
		void tick().then(() => {
			const selector =
				current?.kind === 'pending' && handle
					? `#${current.attributeId}-new-option`
					: handle
						? `[data-placement-handle="${current?.kind === 'answer' ? current.answerId : ''}"]`
						: `[data-row-id="${current?.kind === 'answer' ? current.answerId : current?.attributeId}"]`;
			const element = host.root?.querySelector<HTMLElement>(selector);
			element?.focus({ preventScroll: true });
			if (handle && element)
				focusTimer = setTimeout(() => {
					if (element.isConnected) element.focus({ preventScroll: true });
				}, 0);
		});
	}
	function cleanup() {
		clearTimeout(focusTimer);
		clearTimeout(expansionTimer);
		clearInterval(autoScrollTimer);
		expansionTimer = undefined;
		autoScrollTimer = undefined;
		pointerPosition = null;
		dragPreview = null;
		refusal = null;
		detach();
		detach = () => {};
		if (armed?.handle.hasPointerCapture?.(armed.event.pointerId)) {
			armed.handle.releasePointerCapture(armed.event.pointerId);
		}
		armed = null;
		dragging = false;
		reorderDrop = null;
	}
	function cancel(restore = true) {
		const current = source;
		if (source) announcement = m.configuration_placement_cancelled({ name: label() });
		source = null;
		destination = null;
		cleanup();
		if (restore) focusSource(current);
	}
	function begin(current: Source) {
		if (host.disabled) return;
		cancel(false);
		source = current;
		announcement = m.configuration_placement_choose({ name: label() });
		focusSource(source, false);
	}
	function targetFrom(element: Element | null): PlacementTarget | null {
		const target = element?.closest<HTMLElement>('[data-placement-parent]');
		if (!target || !host.root?.contains(target)) return null;
		const attributeId = target.dataset.placementAttribute ?? '';
		const parentId = target.dataset.placementParent ?? '';
		return target.dataset.placementPromote === undefined
			? { attributeId, parentId }
			: { attributeId, parentId, promote: true };
	}
	/** A sibling row's outer quarter under the pointer: the drop goes beside that row, not under it. */
	function reorderZoneAt(x: number, y: number): { targetId: string; after: boolean } | null {
		const current = source;
		if (current?.kind !== 'answer') return null;
		const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-reorder-row]');
		if (!row || !host.root?.contains(row)) return null;
		const targetId = row.dataset.reorderRow ?? '';
		if (row.dataset.reorderAttribute !== current.attributeId || targetId === current.answerId)
			return null;
		const owner = attributeNamed(current.attributeId);
		const parentOf = (id: string) =>
			owner?.answers.find((answer) => answer.id === id)?.parentId ?? '';
		if (!owner || parentOf(targetId) !== parentOf(current.answerId)) return null;
		const box = row.getBoundingClientRect();
		const zone = rowEdgeZone(y, box.top, box.height);
		return zone === 'inside' ? null : { targetId, after: zone === 'after' };
	}
	function queueExpansion(target: PlacementTarget | null) {
		clearTimeout(expansionTimer);
		expansionTimer = undefined;
		if (!target || target.promote || !eligible(target)) return;
		// An Attribute row opens onto its top level; an answer row opens onto its own children.
		const expandId = target.parentId || target.attributeId;
		const owner = attributeNamed(target.attributeId);
		if (!owner || host.expandedIds.has(expandId)) return;
		if (!owner.answers.some((answer) => (answer.parentId ?? '') === target.parentId)) return;
		const candidate = { ...target };
		expansionTimer = setTimeout(() => {
			expansionTimer = undefined;
			if (
				destination?.attributeId === candidate.attributeId &&
				destination.parentId === candidate.parentId &&
				eligible(candidate) &&
				!host.expandedIds.has(expandId)
			)
				host.expand(expandId);
		}, EXPANSION_DELAY_MS);
	}
	function startAutoScroll() {
		clearInterval(autoScrollTimer);
		autoScrollTimer = setInterval(() => {
			const position = pointerPosition;
			const region = host.root?.closest<HTMLElement>('[data-testid="worker-column"]');
			if (!position || !region) return;
			const bounds = region.getBoundingClientRect();
			const maximum = region.scrollHeight - region.clientHeight;
			let nextTop = region.scrollTop;
			if (position.y < bounds.top + SCROLL_EDGE_PX && nextTop > 0) {
				nextTop = Math.max(0, nextTop - SCROLL_STEP_PX);
			} else if (position.y > bounds.bottom - SCROLL_EDGE_PX && nextTop < maximum) {
				nextTop = Math.min(maximum, nextTop + SCROLL_STEP_PX);
			}
			if (nextTop === region.scrollTop) return;
			region.scrollTop = nextTop;
			choose(targetFrom(document.elementFromPoint(position.x, position.y)));
		}, 16);
	}
	function choose(target: PlacementTarget | null) {
		const next = target && eligible(target) ? target : null;
		const reason = target && !next ? refusalFor(target) : '';
		const nextRefusal: PlacementRefusal | null = target && reason ? { target, reason } : null;
		if (!sameRefusal(refusal, nextRefusal)) {
			refusal = nextRefusal;
			if (nextRefusal) {
				announcement = m.configuration_placement_refused({ reason: nextRefusal.reason });
			}
		}
		if (!sameTarget(destination, next)) {
			destination = next;
			queueExpansion(next);
		}
	}
	function targetName(target: PlacementTarget) {
		if (target.promote) return sourceLeafName();
		const item = attributeNamed(target.attributeId);
		if (!item) return '';
		if (!target.parentId) return item.name;
		const path = answerPathLabel(visibleValues(item.answers), target.parentId);
		return target.attributeId === source?.attributeId ? path : `${item.name} / ${path}`;
	}
	function sourceLeafName() {
		const item = attribute();
		const current = source;
		if (!item || !current) return '';
		if (current.kind === 'pending') return current.value;
		return (
			visibleValues(item.answers).find((answer) => answer.id === current.answerId)?.value ?? ''
		);
	}
	/** Opens the path from an Attribute down to a placed answer, as the draft left it. */
	function expandPath(owner: AttributeDraft, parentId: string) {
		for (let id = parentId || owner.id; id;) {
			if (!host.expandedIds.has(id)) host.expand(id);
			id =
				owner.answers.find((candidate) => candidate.id === id)?.parentId ??
				(id === owner.id ? '' : owner.id);
		}
	}
	/** A placement the draft refused: the Attribute's own reason, or a plain cancellation. */
	function failed(current: Source) {
		const error = attributeNamed(current.attributeId)?.moveError;
		announcement = error || m.configuration_placement_cancelled({ name: label() });
		source = null;
		destination = null;
		cleanup();
		focusSource(current);
	}
	function confirm(target: PlacementTarget | null) {
		const current = source;
		if (!target || !current || !eligible(target)) {
			const reason = target && current ? refusalFor(target) : '';
			cancel();
			if (reason) announcement = m.configuration_placement_refused({ reason });
			return;
		}
		const item = attribute()!;
		const name = label();
		const parentName = targetName(target);
		const owner = target.promote ? undefined : attributeNamed(target.attributeId);
		let placedId: string;
		let done: string;
		let focusHandle = false;
		if (current.kind === 'pending') {
			const createdId = host.create(current.attributeId, current.value, target.parentId);
			if (!createdId) {
				announcement = item.newOptionError;
				source = null;
				destination = null;
				cleanup();
				focusSource(current);
				return;
			}
			placedId = createdId;
			done = m.configuration_placement_done({ name, parent: parentName });
		} else if (target.promote) {
			const leaf = sourceLeafName();
			const answer = { attributeId: current.attributeId, answerId: current.answerId };
			if (!host.promote(answer)) return failed(current);
			placedId = current.answerId;
			done = m.configuration_placement_done_promoted({ name: leaf });
		} else if (target.attributeId !== current.attributeId) {
			if (
				!host.moveToAttribute(
					{ attributeId: current.attributeId, answerId: current.answerId },
					{
						attributeId: target.attributeId,
						parentId: target.parentId
					}
				)
			) {
				return failed(current);
			}
			placedId = current.answerId;
			focusHandle = true;
			done = m.configuration_placement_done_attribute({ name, parent: parentName });
		} else {
			placedId = current.answerId;
			const answer = visibleValues(item.answers).find((answer) => answer.id === current.answerId)!;
			if ((answer.parentId ?? '') !== target.parentId)
				host.move(current.attributeId, current.answerId, target.parentId);
			done = m.configuration_placement_done({ name, parent: parentName });
		}
		if (owner) expandPath(owner, target.parentId);
		announcement = attributeNamed(current.attributeId)?.moveError || done;
		source = null;
		destination = null;
		cleanup();
		focusSource(
			{ kind: 'answer', attributeId: current.attributeId, answerId: placedId },
			focusHandle
		);
	}
	function confirmReorder(
		current: Extract<Source, { kind: 'answer' }>,
		drop: { targetId: string; after: boolean }
	) {
		const name = label();
		const changed = host.reorderBeside(
			current.attributeId,
			current.answerId,
			drop.targetId,
			drop.after
		);
		source = null;
		destination = null;
		cleanup();
		if (changed) announcement = m.configuration_reorder_dropped({ name, ...place(current) });
		focusSource(current);
	}
	function place(current: Extract<Source, { kind: 'answer' }>) {
		const answers = attributeNamed(current.attributeId)?.answers ?? [];
		return siblingPosition(answers, current.answerId);
	}
	function pointerDown(event: PointerEvent, current: Source) {
		if (event.button !== 0 || host.disabled) return;
		clearClickSuppression();
		cleanup();
		const handle = event.currentTarget as HTMLElement;
		armed = { event, handle, source: current };
		handle.setPointerCapture(event.pointerId);
		const move = (next: PointerEvent) => {
			if (!armed || next.pointerId !== event.pointerId) return;
			if (!dragging && Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) < 5)
				return;
			if (!dragging) {
				source = current;
				dragging = true;
				dragPreview = { x: next.clientX, y: next.clientY };
				focusSource(current, false);
				startAutoScroll();
			}
			next.preventDefault();
			pointerPosition = { x: next.clientX, y: next.clientY };
			dragPreview = { x: next.clientX, y: next.clientY };
			reorderDrop = reorderZoneAt(next.clientX, next.clientY);
			choose(
				reorderDrop ? null : targetFrom(document.elementFromPoint(next.clientX, next.clientY))
			);
		};
		const up = (next: PointerEvent) => {
			if (next.pointerId !== event.pointerId) return;
			if (dragging) {
				suppressNextClick();
				const drop = reorderZoneAt(next.clientX, next.clientY);
				if (drop && current.kind === 'answer') confirmReorder(current, drop);
				else confirm(targetFrom(document.elementFromPoint(next.clientX, next.clientY)));
			} else {
				cleanup();
				if (event.pointerType === 'touch') {
					begin(current);
					suppressNextClick();
				}
			}
		};
		const stop = () => {
			suppressNextClick();
			cancel();
		};
		window.addEventListener('pointermove', move, { passive: false });
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', stop);
		handle.addEventListener('lostpointercapture', stop);
		detach = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', stop);
			handle.removeEventListener('lostpointercapture', stop);
		};
	}
	function clickHandle(current: Source) {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		begin(current);
	}
	function click(event: MouseEvent) {
		if (suppressClick) {
			suppressClick = false;
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}
		if (!source || dragging || (event.target as Element).closest('[data-placement-handle]')) return;
		const target = targetFrom(event.target as Element);
		if (!target) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		confirm(target);
	}
	function touchDestinationUp(event: PointerEvent) {
		if (!source || armed || dragging || event.pointerType !== 'touch') return;
		const target = targetFrom(event.target as Element);
		if (!target || !eligible(target)) return;
		suppressNextClick();
		event.preventDefault();
		event.stopImmediatePropagation();
		confirm(target);
	}
	function keydown(event: KeyboardEvent) {
		if (!source && !armed) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (armed) suppressNextClick();
			cancel();
		} else if (
			source &&
			event.key === 'Enter' &&
			!(event.target as Element).closest('[data-placement-handle]')
		) {
			event.preventDefault();
			event.stopImmediatePropagation();
			// A refused row keeps its reason: Enter on it reports the reason rather than doing nothing.
			confirm(destination ?? refusal?.target ?? null);
		}
	}
	$effect(() => {
		const current = source ?? armed?.source;
		const item = host.attributes.find((candidate) => candidate.id === current?.attributeId);
		if (
			current &&
			(host.disabled ||
				!item ||
				(current.kind === 'answer' &&
					!visibleValues(item.answers).some((answer) => answer.id === current.answerId)) ||
				(current.kind === 'pending' && item.newOption.trim() !== current.value.trim()) ||
				(destination && !eligible(destination)))
		)
			cancel();
	});
	$effect(() => {
		const root = host.root;
		if (!root) return;
		const focus = (event: FocusEvent) => {
			if (!source) return;
			const element = event.target as Element;
			const row = element.closest<HTMLElement>('[data-row-id]');
			if (!row) {
				// The promote zone sits beside the rows, not in one, so it is reached directly.
				if (element.closest('[data-placement-promote]')) choose(targetFrom(element));
				return;
			}
			const own = row.querySelector<HTMLElement>(
				':scope > div:first-child [data-placement-parent]'
			);
			choose(targetFrom(own));
		};
		root.addEventListener('click', click, true);
		root.addEventListener('pointerup', touchDestinationUp, true);
		root.addEventListener('focusin', focus);
		window.addEventListener('click', consumeSuppressedClick, true);
		window.addEventListener('pointerdown', clearClickSuppression, true);
		window.addEventListener('keydown', keydown, true);
		return () => {
			clearTimeout(suppressionTimer);
			root.removeEventListener('click', click, true);
			root.removeEventListener('pointerup', touchDestinationUp, true);
			root.removeEventListener('focusin', focus);
			window.removeEventListener('click', consumeSuppressedClick, true);
			window.removeEventListener('pointerdown', clearClickSuppression, true);
			window.removeEventListener('keydown', keydown, true);
			cancel(false);
		};
	});
	return {
		get source() {
			return source;
		},
		get destination() {
			return destination;
		},
		get refusal() {
			return refusal;
		},
		get announcement() {
			return announcement;
		},
		get sourceLabel() {
			return label();
		},
		get sourceLeafLabel() {
			return sourceLeafName();
		},
		get dragging() {
			return dragging;
		},
		get dragPreview() {
			return dragPreview;
		},
		/** The edge of an answer row the dragged value would land beside, or null. */
		dropEdge(answerId: string): 'top' | 'bottom' | null {
			return reorderDrop?.targetId === answerId ? (reorderDrop.after ? 'bottom' : 'top') : null;
		},
		isDraggingAnswer(answerId: string) {
			return dragging && source?.kind === 'answer' && source.answerId === answerId;
		},
		isDraggingPending(attributeId: string) {
			return dragging && source?.kind === 'pending' && source.attributeId === attributeId;
		},
		get destinationLabel() {
			return destination ? targetName(destination) : '';
		},
		eligible,
		pointerDown,
		clickHandle,
		cancel,
		isDestination(attributeId: string, parentId: string, promote = false) {
			return (
				destination !== null &&
				Boolean(destination.promote) === promote &&
				destination.attributeId === attributeId &&
				destination.parentId === parentId
			);
		}
	};
}
export type AttributePlacement = ReturnType<typeof createAttributePlacement>;
