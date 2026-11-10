/**
 * The Agitations card's page behaviour, specced through the factory the route
 * mounts: page position with clamping, grouping-scoped reset, whole-column fit
 * measurement, card-scoped arrow paging, and ResizeObserver wiring. The literal
 * host stands in for the route, as the Mapping drag factory's literal host
 * stands in for the map.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROUP_GAP_PX, createAgitationsPaging } from './agitations-paging.svelte.ts';

function setup(pageCount = 3, groupingKey = 'attribute-1|north,south') {
	let key = groupingKey;
	const paging = createAgitationsPaging({
		pageCount: () => pageCount,
		groupingKey: () => key
	});
	return {
		paging,
		regroup(next: string) {
			key = next;
			paging.syncGrouping();
		},
		resync() {
			paging.syncGrouping();
		}
	};
}

function cell(width: number) {
	return { getBoundingClientRect: () => ({ width }) };
}

function scroller(clientWidth: number, groups: number[], all = 64, rowName: number | null = 144) {
	return {
		clientWidth,
		querySelectorAll: (selectors: string) =>
			selectors === ':scope > table thead th' ? [{}, cell(all), ...groups.map(cell)] : [],
		querySelector: (selectors: string) => {
			if (selectors === 'tbody th') return rowName === null ? null : cell(rowName);
			return null;
		}
	} as unknown as HTMLElement;
}

function arrow(key: string, target: unknown = { closest: () => null }) {
	return {
		key,
		defaultPrevented: false,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		target,
		preventDefault: vi.fn()
	} as unknown as KeyboardEvent;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('page position', () => {
	it('starts on the first page, unmeasured and not ready', () => {
		const { paging } = setup();
		expect(paging.page).toBe(0);
		expect(paging.groupsPerPage).toBe(4);
		expect(paging.ready).toBe(false);
	});

	it('moves through the host page count and clamps outside it', () => {
		const { paging } = setup(3);
		paging.goTo(1);
		expect(paging.page).toBe(1);
		paging.goTo(99);
		expect(paging.page).toBe(2);
		paging.goTo(-99);
		expect(paging.page).toBe(0);
	});

	it('stays on the first page when there are no pages', () => {
		const { paging } = setup(0);
		paging.goTo(2);
		expect(paging.page).toBe(0);
	});
});

describe('grouping reset', () => {
	it('returns to the first page only when the grouping identity changes', () => {
		const { paging, regroup, resync } = setup(4, 'attribute-1|north,south,east');
		paging.goTo(2);
		expect(paging.page).toBe(2);
		resync();
		expect(paging.page).toBe(2);
		regroup('attribute-1|north,south,west');
		expect(paging.page).toBe(0);
	});

	it('returns to the first page when the grouping attribute changes', () => {
		const { paging, regroup, resync } = setup(4, 'attribute-1|north,south');
		resync();
		paging.goTo(2);
		regroup('attribute-2|cook,server');
		expect(paging.page).toBe(0);
	});
});

describe('whole-column fit', () => {
	it('fits four whole 100px groups beside 144px names and a 64px All in 700px', () => {
		const { paging } = setup();
		expect(paging.measure(scroller(700, [100, 100]))).toBe(4);
	});

	it('reads back a single column when only one group fits', () => {
		const { paging } = setup();
		expect(paging.measure(scroller(300, [100, 100]))).toBe(1);
	});

	it('keeps the current count while no group column is measurable', () => {
		const { paging } = setup();
		paging.refresh(scroller(700, [100, 100]));
		expect(paging.groupsPerPage).toBe(4);
		expect(paging.measure(scroller(700, []))).toBe(4);
	});

	it('refresh settles the count and marks the card ready', () => {
		const { paging } = setup();
		expect(paging.ready).toBe(false);
		paging.refresh(scroller(300, [100, 100]));
		expect(paging.groupsPerPage).toBe(1);
		expect(paging.ready).toBe(true);
	});

	it('refresh without a scroller leaves the card unready', () => {
		const { paging } = setup();
		paging.refresh(undefined);
		expect(paging.ready).toBe(false);
	});

	it('the column gap matches the table cell spacing', () => {
		expect(GROUP_GAP_PX).toBe(4);
	});
});

describe('observer wiring', () => {
	it('measures at once and watches the scroller only, never the table it sizes', () => {
		const observed: unknown[] = [];
		let disconnected = 0;
		class FakeObserver {
			observe(element: unknown) {
				observed.push(element);
			}
			disconnect() {
				disconnected += 1;
			}
		}
		vi.stubGlobal('ResizeObserver', FakeObserver);
		const { paging } = setup();
		const table = {};
		const base = scroller(300, [100, 100]);
		const target = {
			...base,
			querySelector: (selectors: string) => {
				if (selectors === 'table') return table;
				if (selectors === 'tbody th') return cell(144);
				return null;
			}
		} as unknown as HTMLElement;
		const stop = paging.observe(target);
		expect(paging.groupsPerPage).toBe(1);
		expect(paging.ready).toBe(true);
		// The table is the content the fit sizes: watching it would feed each
		// rendered page back into another fit write until the framework trips
		// its update-depth guard (user-reported pager crash). The scroller is
		// layout-fixed, so scroller-only observation cannot loop.
		expect(observed).toEqual([target]);
		stop();
		expect(disconnected).toBe(1);
	});

	it('watches only the scroller when the matrix has no table yet', () => {
		const observed: unknown[] = [];
		class SlimObserver {
			observe(element: unknown) {
				observed.push(element);
			}
			disconnect() {}
		}
		vi.stubGlobal('ResizeObserver', SlimObserver);
		const { paging } = setup();
		const target = scroller(700, [100, 100]);
		paging.observe(target);
		expect(observed).toEqual([target]);
	});
});

describe('card-scoped arrows', () => {
	it('turns pages with Right and Left inside the card', () => {
		const { paging } = setup(3);
		const right = arrow('ArrowRight');
		paging.handleKeydown(right);
		expect(paging.page).toBe(1);
		expect(right.preventDefault).toHaveBeenCalledOnce();
		const left = arrow('ArrowLeft');
		paging.handleKeydown(left);
		expect(paging.page).toBe(0);
		expect(left.preventDefault).toHaveBeenCalledOnce();
	});

	it('ignores keys other than Left and Right', () => {
		const { paging } = setup(3);
		const enter = arrow('Enter');
		paging.handleKeydown(enter);
		expect(paging.page).toBe(0);
		expect(enter.preventDefault).not.toHaveBeenCalled();
	});

	it('ignores arrows with Shift, modifiers, or a consumed event', () => {
		const { paging } = setup(3);
		const variants = [
			{ ...arrow('ArrowRight'), shiftKey: true },
			{ ...arrow('ArrowRight'), ctrlKey: true },
			{ ...arrow('ArrowRight'), metaKey: true },
			{ ...arrow('ArrowRight'), altKey: true },
			{ ...arrow('ArrowRight'), defaultPrevented: true }
		] as unknown as KeyboardEvent[];
		for (const event of variants) paging.handleKeydown(event);
		expect(paging.page).toBe(0);
	});

	it('leaves arrows to editable targets alone', () => {
		const { paging } = setup(3);
		const inInput = arrow('ArrowRight', { closest: () => ({}) });
		paging.handleKeydown(inInput);
		expect(paging.page).toBe(0);
		expect(inInput.preventDefault).not.toHaveBeenCalled();
	});

	it('does nothing when a single page holds every group', () => {
		const { paging } = setup(1);
		const right = arrow('ArrowRight');
		paging.handleKeydown(right);
		expect(paging.page).toBe(0);
		expect(right.preventDefault).not.toHaveBeenCalled();
	});
});
