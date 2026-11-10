/**
 * Sibling reorder from a value's grip (Configuration 05): Space picks the value up and
 * drops it, Up and Down move it among its siblings, Escape puts it back. Every step goes
 * through the shared draft, so Save and Discard treat it like any other edit. Nesting and
 * lifting stay with the placement session; this holds no DOM queries.
 */
import { m } from '#lib/paraglide/messages.js';

export type AnswerReorderHost = {
	disabled: () => boolean;
	/** The answers' ids in draft order, for restoring on cancel. */
	order: (attributeId: string) => string[];
	/** Moves one value among its siblings; returns its new place, or null at an end. */
	move: (
		attributeId: string,
		answerId: string,
		direction: -1 | 1
	) => { position: number; count: number } | null;
	/** The value's place now. */
	place: (attributeId: string, answerId: string) => { position: number; count: number };
	restore: (attributeId: string, order: string[]) => void;
	/** The value's path name as the grip announces it. */
	name: (attributeId: string, answerId: string) => string;
	/** Gives the grip focus again once the draft has rendered. */
	focusGrip: (answerId: string) => Promise<void>;
};

export type ReorderKey = { key: string; preventDefault: () => void; stopPropagation: () => void };

export function createAnswerReorder(host: AnswerReorderHost) {
	let held = $state<{ attributeId: string; answerId: string; order: string[] } | null>(null);
	let announcement = $state('');
	let settling = false;

	function announce(text: string) {
		announcement = text;
	}

	function pickUp(attributeId: string, answerId: string) {
		const name = host.name(attributeId, answerId);
		held = { attributeId, answerId, order: host.order(attributeId) };
		announce(m.configuration_reorder_picked_up({ name, ...host.place(attributeId, answerId) }));
	}

	function finish(commit: boolean) {
		const current = held;
		if (!current) return;
		held = null;
		const name = host.name(current.attributeId, current.answerId);
		if (commit) {
			announce(
				m.configuration_reorder_dropped({
					name,
					...host.place(current.attributeId, current.answerId)
				})
			);
			return;
		}
		host.restore(current.attributeId, current.order);
		announce(m.configuration_reorder_cancelled({ name }));
		settling = true;
		void host.focusGrip(current.answerId).finally(() => (settling = false));
	}

	function keydown(event: ReorderKey, attributeId: string, answerId: string): void {
		if (host.disabled()) return;
		const mine = held?.answerId === answerId;
		if (held && !mine) return;
		if (event.key === ' ') {
			event.preventDefault();
			event.stopPropagation();
			if (mine) finish(true);
			else pickUp(attributeId, answerId);
			return;
		}
		if (!mine) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			finish(false);
			return;
		}
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		event.preventDefault();
		event.stopPropagation();
		const name = host.name(attributeId, answerId);
		const place = host.move(attributeId, answerId, event.key === 'ArrowUp' ? -1 : 1);
		if (!place) {
			announce(m.configuration_reorder_at_end({ name, ...host.place(attributeId, answerId) }));
			return;
		}
		announce(m.configuration_reorder_moved({ name, ...place }));
		settling = true;
		void host.focusGrip(answerId).finally(() => (settling = false));
	}

	return {
		get announcement() {
			return announcement;
		},
		isHeld(answerId: string) {
			return held?.answerId === answerId;
		},
		keydown,
		/** The grip lost focus for good: a held value goes back rather than staying picked up unseen. */
		blur(answerId: string): void {
			if (held?.answerId === answerId && !settling) finish(false);
		}
	};
}

export type AnswerReorder = ReturnType<typeof createAnswerReorder>;
