/**
 * Pins the paging behaviour the Agitations, Breakdown and group pagers share, ahead of merging
 * them into one module (#48): the keyboard rules, page clamping and reset, plus the edge inputs
 * the arithmetic helpers and the measuring code take. Specced through the public factories and
 * helpers with literal hosts; no DOM.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampPageIndex, groupPageRange, paginateGroups } from './agitations-paging.ts';
import { createAgitationsPaging } from './agitations-paging.svelte.ts';
import { createBreakdownPaging } from './breakdown-paging.svelte.ts';
import { createGroupPaging } from './group-paging.svelte.ts';

afterEach(() => vi.unstubAllGlobals());

function key(name: string, overrides: Record<string, unknown> = {}, target: unknown = null) {
	return {
		key: name,
		defaultPrevented: false,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		target,
		preventDefault: vi.fn(),
		...overrides
	} as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

describe('paginateGroups edge inputs', () => {
	it('reads a non-positive or fractional page size as whole groups, never an empty page', () => {
		expect(paginateGroups(['a', 'b'], 0)).toEqual([['a'], ['b']]);
		expect(paginateGroups(['a', 'b'], -3)).toEqual([['a'], ['b']]);
		expect(paginateGroups(['a', 'b'], 0.4)).toEqual([['a'], ['b']]);
		expect(paginateGroups(['a', 'b', 'c'], 2.9)).toEqual([['a', 'b'], ['c']]);
		expect(paginateGroups(['a', 'b'], Number.NaN)).toEqual([['a'], ['b']]);
	});
});

describe('clampPageIndex edge inputs', () => {
	it('floors a fractional index and reads a non-finite one as the first page', () => {
		expect(clampPageIndex(1.9, 4)).toBe(1);
		expect(clampPageIndex(Number.NaN, 4)).toBe(0);
		expect(clampPageIndex(Number.POSITIVE_INFINITY, 4)).toBe(0);
		expect(clampPageIndex(2, Number.NaN)).toBe(0);
		expect(clampPageIndex(2, -1)).toBe(0);
	});

	it('shows the last page for an index past the end, and a zero range when empty', () => {
		expect(groupPageRange([['a'], ['b', 'c']], 9)).toEqual({ start: 2, end: 3, total: 3 });
		expect(groupPageRange([[]], 0)).toEqual({ start: 0, end: 0, total: 0 });
	});
});

describe('keyboard paging, shared by every pager', () => {
	const pagers = {
		group: () => createGroupPaging({ pageCount: () => 3, groupingKey: () => 'k' }),
		agitations: () => createAgitationsPaging({ pageCount: () => 3, groupingKey: () => 'k' })
	};

	it.each(Object.entries(pagers))('%s: arrows turn the page and are consumed', (_name, make) => {
		const paging = make();
		const right = key('ArrowRight');
		paging.handleKeydown(right);
		expect(paging.page).toBe(1);
		expect(right.preventDefault).toHaveBeenCalled();
		paging.handleKeydown(key('ArrowLeft'));
		expect(paging.page).toBe(0);
		paging.handleKeydown(key('ArrowLeft'));
		expect(paging.page).toBe(0);
	});

	it.each(Object.entries(pagers))('%s: leaves other keys and modified arrows alone', (_n, make) => {
		const paging = make();
		for (const event of [
			key('Enter'),
			key('ArrowRight', { shiftKey: true }),
			key('ArrowRight', { ctrlKey: true }),
			key('ArrowRight', { metaKey: true }),
			key('ArrowRight', { altKey: true }),
			key('ArrowRight', { defaultPrevented: true })
		]) {
			paging.handleKeydown(event);
			expect(event.preventDefault).not.toHaveBeenCalled();
		}
		expect(paging.page).toBe(0);
	});

	it.each(Object.entries(pagers))('%s: does not steal arrows from a text field', (_n, make) => {
		const paging = make();
		const target = { closest: (selector: string) => (selector.includes('input') ? {} : null) };
		const event = key('ArrowRight', {}, target);
		paging.handleKeydown(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(paging.page).toBe(0);
	});

	it('does nothing when there is a single page', () => {
		const paging = createGroupPaging({ pageCount: () => 1, groupingKey: () => 'k' });
		const event = key('ArrowRight');
		paging.handleKeydown(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it('resets to the first page only when the grouping identity changes', () => {
		let grouping = 'a';
		const paging = createGroupPaging({ pageCount: () => 4, groupingKey: () => grouping });
		paging.syncGrouping();
		paging.goTo(3);
		paging.syncGrouping();
		expect(paging.page).toBe(3);
		grouping = 'b';
		paging.syncGrouping();
		expect(paging.page).toBe(0);
	});

	it('reads a stale page as the last page once the page count shrinks', () => {
		let count = 4;
		const paging = createGroupPaging({ pageCount: () => count, groupingKey: () => 'k' });
		paging.goTo(3);
		count = 2;
		expect(paging.page).toBe(1);
		count = 0;
		expect(paging.page).toBe(0);
	});
});

describe('agitations fit measuring', () => {
	function paging() {
		return createAgitationsPaging({ pageCount: () => 3, groupingKey: () => 'k' });
	}
	const cell = (width: number) => ({ getBoundingClientRect: () => ({ width }) });
	function scroller(groupWidths: number[], clientWidth = 700) {
		return {
			clientWidth,
			querySelectorAll: () => [{}, cell(64), ...groupWidths.map(cell)],
			querySelector: (selector: string) => (selector === 'tbody th' ? cell(144) : null)
		} as unknown as HTMLElement;
	}

	it('keeps the current count when no group column can be measured', () => {
		const p = paging();
		expect(p.measure(scroller([]))).toBe(4);
		expect(p.measure(scroller([0]))).toBe(4);
	});

	it('fits whole columns beside the pinned columns, never fewer than one', () => {
		vi.stubGlobal('getComputedStyle', () => ({ minWidth: '' }));
		const p = paging();
		// (700 - (144 + 64 + 8) + 4) / (100 + 4) = 4.5 -> 4
		expect(p.measure(scroller([100, 100]))).toBe(4);
		expect(p.measure(scroller([100], 100))).toBe(1);
	});

	it('prefers the declared minimum width of the widest group column', () => {
		vi.stubGlobal('getComputedStyle', (el: unknown) => ({
			minWidth: el === wide ? '200px' : ''
		}));
		const wide = cell(50);
		const element = {
			clientWidth: 700,
			querySelectorAll: () => [{}, cell(64), cell(100), wide],
			querySelector: () => cell(144)
		} as unknown as HTMLElement;
		// (700 - 216 + 4) / (200 + 4) = 2.39 -> 2
		expect(paging().measure(element)).toBe(2);
	});

	it('marks ready on the first refresh and ignores a missing scroller', () => {
		vi.stubGlobal('getComputedStyle', () => ({ minWidth: '' }));
		const p = paging();
		p.refresh(undefined);
		expect(p.ready).toBe(false);
		p.refresh(scroller([100]));
		expect(p.ready).toBe(true);
		expect(p.groupsPerPage).toBe(4);
	});

	it('measures once and returns a no-op stop where ResizeObserver is missing', () => {
		vi.stubGlobal('getComputedStyle', () => ({ minWidth: '' }));
		vi.stubGlobal('ResizeObserver', undefined);
		const p = paging();
		const stop = p.observe(scroller([100]));
		expect(p.ready).toBe(true);
		expect(() => stop()).not.toThrow();
		expect(() => p.observe(undefined)()).not.toThrow();
	});
});

describe('breakdown observe without elements', () => {
	it('stays unready and watches nothing until both the body and the footer exist', () => {
		const observe = vi.fn();
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe = observe;
				disconnect() {}
			}
		);
		const paging = createBreakdownPaging({ groupingKey: () => 'k' });
		const body = { querySelectorAll: () => [], clientHeight: 100 } as unknown as HTMLElement;
		expect(() => paging.observe(undefined, undefined)()).not.toThrow();
		expect(() => paging.observe(body, undefined)()).not.toThrow();
		expect(paging.ready).toBe(false);
		expect(observe).not.toHaveBeenCalled();
		expect(paging.pages).toEqual([]);
	});
});
