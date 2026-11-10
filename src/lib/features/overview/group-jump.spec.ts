import { describe, expect, it } from 'vitest';
import { createGroupPaging } from './group-paging.svelte.ts';
import { createGroupJump } from './group-jump.svelte.ts';

describe('createGroupJump', () => {
	// Support rows run by rate, Agitations columns by configured order: same groups, two orders.
	const support = [['b', 'c'], ['a'], ['d']];
	const matrix = [['a', 'b', 'c'], ['d']];
	function setup() {
		let grouping = 'dept|a,b,c,d';
		const nav = (pages: string[][]) =>
			createGroupPaging({ pageCount: () => pages.length, groupingKey: () => grouping });
		const s = nav(support);
		const m = nav(matrix);
		const jump = createGroupJump({
			pagers: () => [
				{ pages: () => support, goTo: (p) => s.goTo(p) },
				{ pages: () => matrix, goTo: (p) => m.goTo(p) }
			]
		});
		return {
			s,
			m,
			jump,
			regroup: (next: string) => ((grouping = next), s.syncGrouping(), m.syncGrouping())
		};
	}
	it('aligns each pager by identity, whatever its row order', () => {
		const { s, m, jump } = setup();
		expect(jump.jump('d')).toBe(true);
		expect([s.page, m.page]).toEqual([2, 1]);
		jump.jump('a');
		expect([s.page, m.page]).toEqual([1, 0]);
		expect(jump.key).toBe('a');
	});
	it('does nothing for a group no pager holds', () => {
		const { s, m, jump } = setup();
		s.goTo(1);
		expect(jump.jump('zzz')).toBe(false);
		expect([s.page, m.page]).toEqual([1, 0]);
		expect(jump.key).toBeUndefined();
	});
	it('only turns pages; a regroup still resets both', () => {
		const { s, m, jump, regroup } = setup();
		s.syncGrouping();
		m.syncGrouping();
		jump.jump('d');
		expect([s.page, m.page]).toEqual([2, 1]);
		regroup('other|a,b,c,d');
		expect([s.page, m.page]).toEqual([0, 0]);
	});
});
