import { describe, expect, it } from 'vitest';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import { createWorkersSelection } from './data-table-selection.svelte.ts';

const worker = (id: string) => baseWorker({ id, name: id });

/** Binds a mutable Workers table and the subset of ids the filters currently match. */
function harness(ids: string[], matching: string[] = ids) {
	const workers = ids.map(worker);
	const selection = createWorkersSelection(() => workers);
	selection.setMatchingIds(matching);

	return {
		workers,
		selection,
		setMatching(next: string[]) {
			selection.setMatchingIds(next);
		}
	};
}

describe('the Workers table selection', () => {
	it('shrinks a keyboard range without losing an earlier selection', async () => {
		const { selection } = harness(['a', 'b', 'c', 'd']);
		selection.toggle('d', true);
		await selection.setKeyboardRange(['a', 'b', 'c'], ['d']);
		await selection.setKeyboardRange(['a', 'b'], ['d']);
		expect(selection.liveSelection).toEqual(['a', 'b', 'd']);
	});

	it('leaves the keyboard range unchecked when the first-check save refuses', async () => {
		const selection = createWorkersSelection(
			() => ['a', 'b'].map(worker),
			async () => false
		);
		expect(await selection.setKeyboardRange(['a', 'b'], [])).toBe(false);
		expect(selection.count).toBe(0);
	});

	it('counts only the workers the Workers table still has, in Workers table order', () => {
		const { selection } = harness(['a', 'b', 'c']);

		// Out of Workers table order on purpose: the selection reads back in Workers table order.
		selection.toggle('c', true);
		selection.toggle('a', true);

		expect(selection.count).toBe(2);
		expect(selection.liveSelection).toEqual(['a', 'c']);
		expect(selection.isSelected('a')).toBe(true);
		expect(selection.isSelected('b')).toBe(false);
	});

	it('drops an id the Workers table no longer carries without losing the rest', () => {
		const { workers, selection } = harness(['a', 'b']);

		selection.setAllMatching(true);
		expect(selection.count).toBe(2);

		workers.splice(1, 1);

		expect(selection.count).toBe(1);
		expect(selection.liveSelection).toEqual(['a']);
		expect(selection.isSelected('b')).toBe(false);
	});

	it('selects the filter matches, including rows no virtualizer has mounted', () => {
		const { selection } = harness(['a', 'b', 'c', 'd'], ['a', 'd']);

		selection.setAllMatching(true);

		expect(selection.count).toBe(2);
		expect(selection.liveSelection).toEqual(['a', 'd']);
		expect(selection.allMatchingSelected).toBe(true);
		expect(selection.someMatchingSelected).toBe(false);
		expect(selection.outsideFilterCount).toBe(0);
	});

	it('keeps a hidden hand-picked selection and counts it as outside the filters', () => {
		const { selection } = harness(['a', 'b', 'c'], ['a', 'b']);

		selection.toggle('c', true);
		expect(selection.outsideFilterCount).toBe(1);

		selection.setAllMatching(true);

		expect(selection.count).toBe(3);
		expect(selection.liveSelection).toEqual(['a', 'b', 'c']);
		expect(selection.outsideFilterCount).toBe(1);
	});

	it('unchecking the header removes the matches and leaves the hidden selection', () => {
		const { selection } = harness(['a', 'b', 'c'], ['a', 'b']);

		selection.setAllMatching(true);
		selection.toggle('c', true);
		expect(selection.count).toBe(3);

		selection.setAllMatching(false);

		expect(selection.liveSelection).toEqual(['c']);
		expect(selection.count).toBe(1);
		expect(selection.outsideFilterCount).toBe(1);
	});

	it('reads indeterminate when only some matches are selected', () => {
		const { selection } = harness(['a', 'b', 'c'], ['a', 'b']);

		selection.toggle('a', true);

		expect(selection.allMatchingSelected).toBe(false);
		expect(selection.someMatchingSelected).toBe(true);
		expect(selection.outsideFilterCount).toBe(0);
	});

	it('is neither checked nor indeterminate with zero matches', () => {
		const { selection } = harness(['a', 'b'], []);

		selection.toggle('a', true);

		expect(selection.matchingCount).toBe(0);
		expect(selection.allMatchingSelected).toBe(false);
		expect(selection.someMatchingSelected).toBe(false);
		// The hand-picked Worker is still selected; nothing matches, so the header is inert.
		expect(selection.count).toBe(1);
	});

	it('empties the selection with clear', () => {
		const { selection } = harness(['a', 'b']);

		selection.setAllMatching(true);
		selection.clear();

		expect(selection.count).toBe(0);
		expect(selection.isSelected('a')).toBe(false);
	});
});
