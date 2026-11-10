import { afterEach, expect, it, vi } from 'vitest';
import { createOverviewBreakdownCard } from './overview-breakdown-card.svelte.ts';

afterEach(() => vi.unstubAllGlobals());

it('keys the grouping by Attribute and group ids, and pages once measured', () => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		}
	);
	let attributeId: string | undefined = 'department';
	let ids = ['north', 'south', 'east'];
	const card = createOverviewBreakdownCard({ attributeId: () => attributeId, groupIds: () => ids });
	expect(card.groupingKey).toBe('department|north,south,east');
	expect(card.showFooter).toBe(false);

	const rows = Array.from({ length: 3 }, () => ({ getBoundingClientRect: () => ({ height: 88 }) }));
	const body = { clientHeight: 250, querySelectorAll: () => rows } as unknown as HTMLElement;
	const footer = { getBoundingClientRect: () => ({ height: 72 }) } as unknown as HTMLElement;
	const stop = card.observe(body, footer);
	expect(card.paging.ready).toBe(true);
	expect(card.visibleRows).toEqual([0, 1]);
	expect(card.range).toEqual({ start: 1, end: 2, total: 3 });
	expect(card.showFooter).toBe(true);

	card.paging.goTo(1);
	expect(card.visibleRows).toEqual([2]);
	expect(card.range).toEqual({ start: 3, end: 3, total: 3 });

	attributeId = undefined;
	ids = [];
	expect(card.groupingKey).toBe('|');
	stop();
});
