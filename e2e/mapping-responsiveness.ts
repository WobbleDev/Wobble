import type { APIRequestContext, Page } from '@playwright/test';
import { workerUpdateFrom } from './api.ts';
import { expect } from './fixtures.ts';

type DatasetWorker = {
	id: string;
	name: string;
	email: string;
	phone: string;
	assessment: string;
	attributes: Record<string, unknown>;
	agitations: string[];
	languages: string[];
	relationships: string[];
	notes: unknown[];
};

export async function seedRelationshipHub(request: APIRequestContext, total = 50) {
	const names = Array.from({ length: total }, (_, index) => `Map Worker ${index + 1}`);
	const created = await request.post('/api/workers', { data: names.map((name) => ({ name })) });
	expect(created.ok(), await created.text()).toBeTruthy();

	const response = await request.get('/api/dataset');
	expect(response.ok(), await response.text()).toBeTruthy();
	const dataset = (await response.json()) as { workers: DatasetWorker[] };
	const hub = dataset.workers.find((worker) => worker.name === 'Map Worker 1');
	if (!hub) throw new Error('the hub worker is missing from the dataset');
	const spokes = dataset.workers.filter((worker) => worker.id !== hub.id).map(({ id }) => id);
	expect(spokes).toHaveLength(total - 1);

	const fields = workerUpdateFrom(hub);
	const related = await request.put(`/api/workers/${hub.id}`, {
		data: { ...fields, relationships: spokes }
	});
	expect(related.ok(), await related.text()).toBeTruthy();
}

export type ResponsivenessProbe = {
	startedAt: number;
	previousAt: number;
	maxGapMs: number;
	maxGapAtMs: number;
	longTasks: { startTime: number; duration: number }[];
	marks: { name: string; elapsedMs: number }[];
	ticks: number;
	timerId: number;
	observer: PerformanceObserver;
};

type ProbedWindow = Window & { __mappingResponsivenessProbe?: ResponsivenessProbe };

export async function startResponsivenessProbe(page: Page) {
	await page.evaluate(() => {
		const startedAt = performance.now();
		const probe: ResponsivenessProbe = {
			startedAt,
			previousAt: startedAt,
			maxGapMs: 0,
			maxGapAtMs: 0,
			longTasks: [],
			marks: [],
			ticks: 0,
			timerId: 0,
			observer: new PerformanceObserver((entries) => {
				for (const entry of entries.getEntries()) {
					probe.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
				}
			})
		};
		probe.observer.observe({ type: 'longtask', buffered: true });
		probe.timerId = window.setInterval(() => {
			const now = performance.now();
			const gap = now - probe.previousAt - 100;
			if (gap > probe.maxGapMs) {
				probe.maxGapMs = gap;
				probe.maxGapAtMs = now - probe.startedAt;
			}
			probe.previousAt = now;
			probe.ticks += 1;
		}, 100);
		(window as ProbedWindow).__mappingResponsivenessProbe = probe;
	});
}

export async function recordMark(page: Page, name: string) {
	await page.evaluate((markName) => {
		const probe = (window as ProbedWindow).__mappingResponsivenessProbe;
		if (!probe) throw new Error('Mapping responsiveness probe was not started');
		probe.marks.push({ name: markName, elapsedMs: performance.now() - probe.startedAt });
	}, name);
}

export async function stopResponsivenessProbe(page: Page) {
	return page.evaluate(() => {
		const probe = (window as ProbedWindow).__mappingResponsivenessProbe;
		if (!probe) throw new Error('Mapping responsiveness probe was not started');
		window.clearInterval(probe.timerId);
		probe.observer.disconnect();
		return {
			startedAt: probe.startedAt,
			elapsedMs: performance.now() - probe.startedAt,
			maxGapMs: probe.maxGapMs,
			maxGapAtMs: probe.maxGapAtMs,
			longTasks: probe.longTasks,
			marks: probe.marks,
			ticks: probe.ticks
		};
	});
}
