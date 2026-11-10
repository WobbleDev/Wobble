import { afterEach, expect, it, vi } from 'vitest';
import { createBreakdownPaging } from './breakdown-paging.svelte.ts';

afterEach(() => vi.unstubAllGlobals());

it('measures retained rows, refits on resize, and resets only for a new grouping', () => {
	let resize = () => {};
	let disconnected = false;
	const observed: unknown[] = [];
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe(element: unknown) {
				observed.push(element);
			}
			disconnect() {
				disconnected = true;
			}
		}
	);
	let key = 'department|north,south,east,west,central';
	const paging = createBreakdownPaging({ groupingKey: () => key });
	let height = 250;
	const rows = Array.from({ length: 5 }, () => ({ getBoundingClientRect: () => ({ height: 88 }) }));
	const body = {
		get clientHeight() {
			return height;
		},
		querySelectorAll: () => rows
	} as unknown as HTMLElement;
	const footer = { getBoundingClientRect: () => ({ height: 72 }) } as unknown as HTMLElement;
	const stop = paging.observe(body, footer);
	expect(paging.ready).toBe(true);
	expect(paging.pages).toEqual([[0, 1], [2, 3], [4]]);
	expect(observed).toEqual([body, footer, ...rows]);
	paging.syncGrouping();
	paging.goTo(2);
	paging.syncGrouping();
	expect(paging.page).toBe(2);
	height = 350;
	resize();
	expect(paging.page).toBe(1);
	paging.handleKeydown({
		key: 'ArrowLeft',
		target: null,
		preventDefault: vi.fn()
	} as unknown as KeyboardEvent);
	expect(paging.page).toBe(0);
	// The permanent footer always reserves its height: five 88px rows need 512px.
	height = 512;
	resize();
	expect(paging.pages).toEqual([[0, 1, 2, 3, 4]]);
	expect(paging.page).toBe(0);
	height = 250;
	resize();
	paging.goTo(1);
	key = 'role|cook,server';
	paging.syncGrouping();
	expect(paging.page).toBe(0);
	stop();
	expect(disconnected).toBe(true);
});
