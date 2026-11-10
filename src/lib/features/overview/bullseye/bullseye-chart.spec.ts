import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { Worker } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import BullseyeChart from './bullseye-chart.svelte';

const worker = (id: string, assessment: Worker['assessment'], relationships: string[] = []) =>
	baseWorker({ id, name: id, assessment, relationships });

const workers = [
	worker('Leader worker', 'Leader', ['Activist worker', 'Supporter worker']),
	worker('Activist worker', 'Activist', ['Leader worker', 'Supporter worker']),
	worker('Supporter worker', 'Supporter', ['Leader worker', 'Activist worker', 'Hostile worker']),
	worker('Disengaged worker', 'Disengaged', ['Hostile worker']),
	worker('Hostile worker', 'Hostile', ['Supporter worker', 'Disengaged worker']),
	worker('Unassessed worker', 'Unassessed')
];

describe('BullseyeChart', () => {
	it('draws the marks and no names the server cannot size: the ring labels wait for a measurement', () => {
		const { body } = render(BullseyeChart, { props: { workers, id: 'chart' } });

		expect(body).toContain('role="group"');

		// The names are set in interface pixels and converted to user units from the
		// chart's own rendered width, so there is nothing to draw until a browser has
		// measured it. The meaning still travels with the marks either way: the
		// description names every ring, its count, and the Committee at the centre.
		const chart = body.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? '';
		expect(chart).not.toContain('<text');
		expect(chart).toContain('Leader: 1');
		expect(chart).toContain('Unassessed, not plotted: 1');

		expect(body).not.toContain('<button');
		expect(body).not.toContain('data-slot="card"');
	});

	it('names itself from the id it is given, not one of its own', () => {
		const { body } = render(BullseyeChart, { props: { workers, id: 'chart' } });

		expect(body).toContain('id="chart-chart-title"');
		expect(body).toContain('id="chart-chart-description"');
		expect(body).toContain('aria-labelledby="chart-chart-title"');
		expect(body).toContain('aria-describedby="chart-chart-description"');
	});

	it('exposes every dot as a focusable entity named after its worker', () => {
		const { body } = render(BullseyeChart, { props: { workers, id: 'chart' } });

		const dotCircles = body.match(/<circle [^>]*data-worker-id="[^"]+"[^>]*>/g) ?? [];
		expect(dotCircles).toHaveLength(5); // the five assessed workers

		expect(body).toContain('data-worker-id="Leader worker"');
		expect(body).toContain('aria-label="Leader worker — Leader"');

		// Roving tabindex: one dot in the tab order, the rest out of it.
		expect(body.match(/<circle [^>]*tabindex="0"[^>]*>/g)).toHaveLength(1);
		expect(body.match(/<circle [^>]*tabindex="-1"[^>]*>/g)).toHaveLength(4);
	});
});
