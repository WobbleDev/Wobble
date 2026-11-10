import { describe, expect, it } from 'vitest';
import { createOverviewGrouping, resolveGroupingAttribute } from './overview-grouping.svelte.ts';

const department = { id: 'dept', name: 'Department' };
const site = { id: 'site', name: 'Site' };

function setup(initial = '', categories = [site, department]) {
	const params = new URLSearchParams();
	let replaced = 0;
	const grouping = createOverviewGrouping({
		categories: () => categories,
		initial: () => initial,
		replaceUrl: (edit) => {
			if (edit(params) !== false) replaced += 1;
		}
	});
	return { grouping, params, replaced: () => replaced };
}

describe('resolveGroupingAttribute', () => {
	it('prefers the named Attribute, then Department, then the first category', () => {
		expect(resolveGroupingAttribute([site, department], 'site')).toBe(site);
		expect(resolveGroupingAttribute([site, department], 'unknown')).toBe(department);
		expect(resolveGroupingAttribute([site], '')).toBe(site);
		expect(resolveGroupingAttribute([], '')).toBeUndefined();
	});
});

describe('createOverviewGrouping', () => {
	it('opens on the address value and falls back when it names nothing', () => {
		expect(setup('site').grouping.attribute).toBe(site);
		expect(setup('missing').grouping.attribute).toBe(department);
	});

	it('follows the bound value', () => {
		const { grouping } = setup();
		grouping.groupBy = 'site';
		expect(grouping.groupBy).toBe('site');
		expect(grouping.attribute).toBe(site);
	});

	it('writes by= into the address, ignoring an empty or unchanged choice', () => {
		const { grouping, params, replaced } = setup();
		grouping.change('');
		expect(replaced()).toBe(0);
		grouping.change('site');
		expect(params.get('by')).toBe('site');
		expect(replaced()).toBe(1);
		grouping.change('site');
		expect(replaced()).toBe(1);
	});
});
