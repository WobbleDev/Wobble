import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { Worker } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import AssessmentBullseye from './assessment-bullseye.svelte';

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

describe('AssessmentBullseye', () => {
	it('stands on its own: no card, no key, and no in-chart labels', () => {
		const { body } = render(AssessmentBullseye, { props: { workers } });

		// The chart is the Overview's dominant object and draws no chrome of its
		// own: no card, no heading, and no visible key beside it.
		expect(body).not.toContain('data-slot="card"');
		expect(body).not.toContain('data-slot="card-header"');
		expect(body).not.toContain('Assessment key');
		expect(body).not.toContain('<ul');

		const chart = body.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? '';
		expect(chart).not.toContain('<text');

		expect(body).not.toContain('<button');
	});

	it('hands the chart its own id, so the accessible name travels with the marks', () => {
		const { body } = render(AssessmentBullseye, { props: { workers } });

		const chart = body.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? '';
		expect(chart).toContain('role="group"');
		expect(chart).toContain('-chart-title');
		expect(chart).toContain('-chart-description');
	});

	it('shows no name until one is active, and draws no ground of its own', () => {
		const { body } = render(AssessmentBullseye, { props: { workers } });

		// The hover name is the reader's, not the chart's: nothing is drawn until a
		// dot has been entered or focused...
		expect(body).not.toContain('data-bullseye-callout');
		// ...and the dragged ground is the shell's, so this component never claims it.
		expect(body).not.toContain('data-bullseye-base');
	});
});
