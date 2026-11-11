import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import MapEmptyState from './map-empty-state.svelte';

const props = {
	hiddenCount: 2,
	activeFilterLabels: ['Team'],
	isolateName: 'Worker 07',
	onClearFilters: () => {},
	onExitIsolate: () => {}
};

function html(kind: 'worksite' | 'filters' | 'isolate') {
	return render(MapEmptyState, { props: { ...props, kind } }).body;
}

describe('MapEmptyState', () => {
	it('offers Workers for an empty Worksite, with no Clear filters', () => {
		const body = html('worksite');
		expect(body).toContain('Add first worker');
		expect(body).toContain('href="/workers"');
		expect(body).not.toContain('Clear filters');
	});

	it('offers Clear filters, with the hidden count, for filter exclusion', () => {
		const body = html('filters');
		expect(body).toContain('Clear filters');
		expect(body).toContain('2 hidden by Team');
		expect(body).not.toContain('Exit Isolate');
	});

	it('names the Isolate focus and offers Exit Isolate, not Clear filters', () => {
		const body = html('isolate');
		expect(body).toContain('Isolate on Worker 07 shows no workers.');
		expect(body).toContain('Exit Isolate');
		expect(body).not.toContain('Clear filters');
	});
});
