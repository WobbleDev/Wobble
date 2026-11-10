import { describe, expect, it } from 'vitest';
import { createAnswerReorder, type AnswerReorderHost } from './answer-reorder.svelte.ts';

function setup() {
	let order = ['a', 'b', 'c'];
	let disabled = false;
	const calls: string[] = [];
	const host: AnswerReorderHost = {
		disabled: () => disabled,
		order: () => [...order],
		move(_attribute, id, direction) {
			const from = order.indexOf(id);
			const to = from + direction;
			if (to < 0 || to >= order.length) return null;
			[order[from], order[to]] = [order[to], order[from]];
			return { position: to + 1, count: order.length };
		},
		place: (_attribute, id) => ({ position: order.indexOf(id) + 1, count: order.length }),
		restore(_attribute, saved) {
			order = [...saved];
			calls.push('restore');
		},
		name: (_attribute, id) => id.toUpperCase(),
		focusGrip: async (id) => void calls.push(`focus ${id}`)
	};
	const reorder = createAnswerReorder(host);
	const press = (key: string, id = 'b') => {
		const event = { key, preventDefault: () => {}, stopPropagation: () => {} };
		reorder.keydown(event, 'attr', id);
	};
	return { reorder, press, calls, order: () => order, disable: () => (disabled = true) };
}

describe('sibling reorder from the grip', () => {
	it('picks up with Space, moves with arrows and drops with Space', () => {
		const { reorder, press, order } = setup();
		press(' ');
		expect(reorder.isHeld('b')).toBe(true);
		expect(reorder.announcement).toBe('B picked up, 2 of 3.');
		press('ArrowUp');
		expect(order()).toEqual(['b', 'a', 'c']);
		expect(reorder.announcement).toBe('B moved to 1 of 3.');
		press(' ');
		expect(reorder.isHeld('b')).toBe(false);
		expect(reorder.announcement).toBe('B dropped at 1 of 3.');
		expect(order()).toEqual(['b', 'a', 'c']);
	});

	it('stays put at an end and says so', () => {
		const { reorder, press, order } = setup();
		press(' ');
		press('ArrowDown');
		press('ArrowDown');
		expect(order()).toEqual(['a', 'c', 'b']);
		expect(reorder.announcement).toBe('B stays at 3 of 3.');
	});

	it('puts the order back on Escape', () => {
		const { reorder, press, order, calls } = setup();
		press(' ');
		press('ArrowUp');
		press('Escape');
		expect(order()).toEqual(['a', 'b', 'c']);
		expect(reorder.isHeld('b')).toBe(false);
		expect(reorder.announcement).toBe('Reorder of B cancelled.');
		expect(calls).toContain('restore');
	});

	it('ignores arrows until a value is held, and does nothing while saving', () => {
		const { reorder, press, order, disable } = setup();
		press('ArrowUp');
		expect(order()).toEqual(['a', 'b', 'c']);
		disable();
		press(' ');
		expect(reorder.isHeld('b')).toBe(false);
	});

	it('restores a held value when its grip loses focus', async () => {
		const { reorder, press, order } = setup();
		press(' ');
		press('ArrowUp');
		await Promise.resolve();
		await Promise.resolve();
		reorder.blur('b');
		expect(order()).toEqual(['a', 'b', 'c']);
	});
});
