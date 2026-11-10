import { describe, expect, it } from 'vitest';
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import type { PopulationFilters } from '#lib/shared/worker-population.ts';
import { selectWorkerPopulation } from '#lib/shared/worker-population.ts';
import {
	parseWorkerFilters,
	writeWorkerFilters,
	type WorkerFilters
} from '#lib/shared/worker-filters.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import { contextualGroupReadings, groupReadings } from './support-summary.ts';
import { agitationDrilldownFilters, groupDrilldownFilters } from './group-drilldown.ts';

const worker = (
	id: string,
	attributes: Record<string, string | string[]> = {},
	agitations: string[] = []
) => baseWorker({ id, name: id, assessment: 'Supporter', attributes, agitations });

const location: WorkerAttributeDefinition = {
	id: 'location',
	name: 'Location',
	kind: 'tag',
	answers: [
		{ id: 'central', value: 'Central' },
		{ id: 'store-a', value: 'Store A', parentId: 'central' },
		{ id: 'packing-central', value: 'Packing', parentId: 'store-a' },
		{ id: 'store-b', value: 'Store B', parentId: 'central' },
		{ id: 'distribution', value: 'Distribution' },
		{ id: 'packing-distribution', value: 'Packing', parentId: 'distribution' }
	]
};

const job: WorkerAttributeDefinition = {
	id: 'job',
	name: 'Job',
	kind: 'category',
	answers: [
		{ id: 'cashier', value: 'Cashier' },
		{ id: 'stocker', value: 'Stocker' }
	]
};

const department: WorkerAttributeDefinition = {
	id: 'department',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'dept-central', value: 'Central' },
		{ id: 'dept-store-a', value: 'Store A', parentId: 'dept-central' },
		{ id: 'dept-remote', value: 'Remote' }
	]
};

const workers: Worker[] = [
	worker('casey', { location: ['central'], job: 'cashier' }),
	worker('drew', { location: ['store-a'], job: 'stocker' }),
	worker('erin', { location: ['central', 'store-a'], job: 'cashier' }),
	worker('frankie', { location: ['store-b'], job: 'cashier' }),
	worker('grace', { location: ['distribution'], job: 'stocker' })
];

function emptyFilters(overrides: Partial<WorkerFilters> = {}): WorkerFilters {
	return {
		answers: new Map(),
		missing: new Set(),
		exactAnswers: new Map(),
		columns: new Map(),
		agitations: new Set(),
		...overrides
	};
}

/** The same conditions as the shared population selector reads them. */
function populationFilters(filters: WorkerFilters): PopulationFilters {
	return {
		answers: filters.answers,
		missing: filters.missing,
		...(filters.exactAnswers ? { exactAnswers: filters.exactAnswers } : {})
	};
}

function drilldownIds(
	filters: WorkerFilters,
	attribute: WorkerAttributeDefinition,
	reading: Parameters<typeof groupDrilldownFilters>[2]
): string[] {
	const drilldown = groupDrilldownFilters(filters, attribute, reading);
	return selectWorkerPopulation(workers, [location, job, department], populationFilters(drilldown))
		.workers.map((entry) => entry.id)
		.sort();
}

describe('Overview hierarchy drilldowns', () => {
	it('starts at the roots and expands one branch into children and an exact remainder', () => {
		const projection = selectWorkerPopulation(workers, [location, job, department]);
		const roots = contextualGroupReadings(projection, location);
		expect(roots.map((row) => [row.value, row.total])).toEqual([
			['Central', 4],
			['Distribution', 1]
		]);

		const expanded = contextualGroupReadings(projection, location, 5, ['central']);
		expect(expanded.map((row) => [row.value, row.total, row.remainder ?? false])).toEqual([
			['Store A', 2, false],
			['Store B', 1, false],
			['Central', 2, true],
			['Distribution', 1, false]
		]);
		expect(expanded[2].description).toBe('this group only');

		// Erin holds Central and Store A, so she is in both rows; each row still
		// deduplicates her once.
		expect(drilldownIds(emptyFilters(), location, expanded[0])).toEqual(['drew', 'erin']);
		expect(drilldownIds(emptyFilters(), location, expanded[2])).toEqual(['casey', 'erin']);
		expect(drilldownIds(emptyFilters(), location, roots[0])).toEqual([
			'casey',
			'drew',
			'erin',
			'frankie'
		]);
	});

	it('keeps an unexpanded child region including its descendants at uneven depth', () => {
		const project = selectWorkerPopulation(
			[...workers, worker('hana', { location: ['packing-central'], job: 'stocker' })],
			[location, job, department]
		);
		const expanded = contextualGroupReadings(project, location, 5, ['central']);
		const storeA = expanded.find((row) => row.answerId === 'store-a');
		expect(storeA?.total).toBe(3);
		expect(storeA?.expandable).toBe(true);
		expect(storeA?.expanded).toBe(false);

		const deeper = contextualGroupReadings(project, location, 5, ['central', 'store-a']);
		expect(deeper.map((row) => [row.value, row.total])).toEqual([
			['Central / Store A / Packing', 1],
			['Store A', 2],
			['Store B', 1],
			['Central', 2],
			['Distribution', 1]
		]);
	});

	it("honours an existing OR filter on another Attribute while replacing this Attribute's own condition", () => {
		const filtered = selectWorkerPopulation(workers, [location, job], {
			answers: new Map([['job', ['cashier', 'stocker']]])
		});
		const expanded = contextualGroupReadings(filtered, location, 5, ['central']);
		const remainder = expanded.find((row) => row.remainder);
		expect(remainder?.total).toBe(2);
		if (!remainder) throw new Error('Central remainder missing');

		const drilldown = groupDrilldownFilters(
			emptyFilters({
				answers: new Map([['job', ['cashier', 'stocker']]])
			}),
			location,
			remainder
		);
		expect(drilldown.answers.get('job')).toEqual(['cashier', 'stocker']);
		expect(drilldown.exactAnswers.get('location')).toEqual(['central']);
		expect(
			selectWorkerPopulation(workers, [location, job], populationFilters(drilldown)).workers.map(
				(entry) => entry.id
			)
		).toEqual(['casey', 'erin']);
	});

	it('reads the remainder from the filtered population only', () => {
		const cashiers = selectWorkerPopulation(workers, [location, job], {
			answers: new Map([['job', ['cashier']]])
		});
		const expanded = contextualGroupReadings(cashiers, location, 5, ['central']);
		// Grace is a Stocker at Distribution, so her record cannot reach the reading;
		// Erin holds Central and Store A, so she is the remainder cohort beside Casey.
		expect(expanded.map((row) => [row.value, row.total, row.remainder ?? false])).toEqual([
			['Store A', 1, false],
			['Store B', 1, false],
			['Central', 2, true]
		]);
		const remainder = expanded.find((row) => row.remainder);
		if (!remainder) throw new Error('Central remainder missing');
		const drilldown = groupDrilldownFilters(
			emptyFilters({ answers: new Map([['job', ['cashier']]]) }),
			location,
			remainder
		);
		expect(
			selectWorkerPopulation(workers, [location, job], populationFilters(drilldown)).workers.map(
				(entry) => entry.id
			)
		).toEqual(['casey', 'erin']);
	});

	it("reproduces every row's cohort through the Workers identity encoding", () => {
		const projection = selectWorkerPopulation(workers, [location, job]);
		const rows = contextualGroupReadings(projection, location, 5, ['central']);
		const expected: Record<string, string[]> = {
			'Store A': ['drew', 'erin'],
			'Store B': ['frankie'],
			'Central#remainder': ['casey', 'erin'],
			Distribution: ['grace']
		};
		expect(rows.map((row) => row.value + (row.remainder ? '#remainder' : ''))).toEqual(
			Object.keys(expected)
		);
		for (const row of rows) {
			const drilldown = groupDrilldownFilters(emptyFilters(), location, row);
			const reparsed = parseWorkerFilters(writeWorkerFilters(new URLSearchParams(), drilldown), [
				location,
				job
			]);
			expect(
				selectWorkerPopulation(workers, [location, job], populationFilters(reparsed))
					.workers.map((entry) => entry.id)
					.sort(),
				row.value
			).toEqual(expected[row.value + (row.remainder ? '#remainder' : '')]);
		}
	});

	it('reads and drills an ordinary Attribute branch exactly', () => {
		const departmentWorkers = [
			worker('casey', { department: 'dept-central' }),
			worker('drew', { department: 'dept-store-a' })
		];
		const roots = groupReadings(departmentWorkers, department);
		expect(roots.map((row) => [row.value, row.total])).toEqual([['Central', 2]]);

		const expanded = groupReadings(departmentWorkers, department, 5, ['dept-central']);
		expect(expanded.map((row) => [row.value, row.total, row.remainder ?? false])).toEqual([
			['Store A', 1, false],
			['Central', 1, true]
		]);

		const drilldown = groupDrilldownFilters(emptyFilters(), department, expanded[1]);
		const cohort = selectWorkerPopulation(
			departmentWorkers,
			[department],
			populationFilters(drilldown)
		);
		expect(cohort.workers.map((entry) => entry.id)).toEqual(['casey']);

		const broad = groupDrilldownFilters(emptyFilters(), department, roots[0]);
		expect(
			selectWorkerPopulation(departmentWorkers, [department], populationFilters(broad)).workers.map(
				(entry) => entry.id
			)
		).toEqual(['casey', 'drew']);
	});

	it('keeps same-named answers in different branches distinct', () => {
		const hana = worker('hana', { location: ['packing-central'], job: 'stocker' });
		const ivan = worker('ivan', { location: ['packing-distribution'], job: 'stocker' });
		const everyone = [...workers, hana, ivan];
		const project = selectWorkerPopulation(everyone, [location, job]);
		const rows = contextualGroupReadings(project, location, 5, [
			'central',
			'store-a',
			'distribution'
		]);
		const packingRows = rows.filter((row) => row.answerId.startsWith('packing'));
		expect(packingRows.map((row) => [row.value, row.total, row.answerId])).toEqual([
			['Central / Store A / Packing', 1, 'packing-central'],
			['Distribution / Packing', 1, 'packing-distribution']
		]);
		const drilldown = groupDrilldownFilters(emptyFilters(), location, packingRows[1]);
		expect(
			selectWorkerPopulation(everyone, [location, job], populationFilters(drilldown)).workers.map(
				(entry) => entry.id
			)
		).toEqual(['ivan']);
	});
});

/** The cohort one filter set selects in the shared population projection. */
function populationIds(list: Worker[], filters: WorkerFilters): string[] {
	return selectWorkerPopulation(list, [location, job, department], populationFilters(filters))
		.workers.map((entry) => entry.id)
		.sort();
}

/** The cohort a row opens after its predicate is intersected with the active filters. */
function drilldownCohort(
	list: Worker[],
	filters: WorkerFilters,
	attribute: WorkerAttributeDefinition,
	reading: Parameters<typeof groupDrilldownFilters>[2]
): string[] {
	return populationIds(list, groupDrilldownFilters(filters, attribute, reading));
}

/** The same filters after their Workers address encoding round-trips. */
function readBack(filters: WorkerFilters): WorkerFilters {
	return parseWorkerFilters(writeWorkerFilters(new URLSearchParams(), filters), [
		location,
		job,
		department
	]);
}

describe('Overview drilldowns intersect an active same-Attribute condition', () => {
	const storeA = () => emptyFilters({ answers: new Map([['location', ['store-a']]]) });
	const central = () => emptyFilters({ answers: new Map([['location', ['central']]]) });

	it('keeps a descendant Location filter when the row is its parent region', () => {
		// Under Location = Store A, the Central row reads the Store A cohort, so its
		// drilldown must keep Store A and never write Central.
		const reading = { attributeId: 'location', answerId: 'central' };
		const drilldown = groupDrilldownFilters(storeA(), location, reading);
		expect(drilldown.answers.get('location')).toEqual(['store-a']);
		expect(drilldown.exactAnswers.get('location')).toBeUndefined();
		expect(populationIds(workers, drilldown)).toEqual(['drew', 'erin']);

		// The address carries the kept condition and reads back the same cohort.
		const reparsed = readBack(drilldown);
		expect(reparsed.answers.get('location')).toEqual(['store-a']);
		expect(populationIds(workers, reparsed)).toEqual(['drew', 'erin']);
	});

	it('replaces a broader Location filter with a row inside it', () => {
		const reading = { attributeId: 'location', answerId: 'store-a' };
		const drilldown = groupDrilldownFilters(central(), location, reading);
		expect(drilldown.answers.get('location')).toEqual(['store-a']);
		expect(populationIds(workers, drilldown)).toEqual(['drew', 'erin']);
	});

	it('opens nobody when the row is disjoint from the Location filter', () => {
		const filtered = emptyFilters({
			answers: new Map([['location', ['distribution']]])
		});
		const reading = { attributeId: 'location', answerId: 'central' };
		expect(drilldownCohort(workers, filtered, location, reading)).toEqual([]);
		const drilldown = groupDrilldownFilters(filtered, location, reading);
		expect(populationIds(workers, drilldown)).toEqual([]);
		expect(populationIds(workers, readBack(drilldown))).toEqual([]);
	});

	it('keeps an exact remainder filter and intersects it with a remainder row', () => {
		const exactFilter = emptyFilters({
			exactAnswers: new Map([['location', ['central']]])
		});
		const remainder = { attributeId: 'location', answerId: 'central', remainder: true };
		const kept = groupDrilldownFilters(exactFilter, location, remainder);
		expect(kept.exactAnswers.get('location')).toEqual(['central']);
		expect(populationIds(workers, kept)).toEqual(['casey', 'erin']);

		// A broader ordinary filter admits the same exact remainder without widening.
		const narrowed = groupDrilldownFilters(central(), location, remainder);
		expect(narrowed.answers.get('location')).toBeUndefined();
		expect(narrowed.exactAnswers.get('location')).toEqual(['central']);
		expect(populationIds(workers, narrowed)).toEqual(['casey', 'erin']);
	});

	it('opens nobody for a remainder disjoint from the Location filter', () => {
		const filtered = emptyFilters({
			answers: new Map([['location', ['distribution']]])
		});
		expect(
			drilldownCohort(workers, filtered, location, {
				attributeId: 'location',
				answerId: 'central',
				remainder: true
			})
		).toEqual([]);
	});

	it('keeps the no-value group only when the filter is the same reading', () => {
		const gapped = [worker('casey', { location: ['central'] }), worker('sam', { job: 'cashier' })];
		const gap = { attributeId: 'location', answerId: '', noValue: true };
		const gapFilter = emptyFilters({ missing: new Set(['location']) });
		const kept = groupDrilldownFilters(gapFilter, location, gap);
		expect(kept.missing.has('location')).toBe(true);
		expect(populationIds(gapped, kept)).toEqual(['sam']);
		expect(drilldownCohort(gapped, central(), location, gap)).toEqual([]);
	});

	it('keeps every other Attribute condition and facet', () => {
		const filtered = emptyFilters({
			answers: new Map([
				['location', ['store-a']],
				['job', ['cashier', 'stocker']]
			]),
			agitations: new Set(['equipment'])
		});
		const drilldown = groupDrilldownFilters(filtered, location, {
			attributeId: 'location',
			answerId: 'central'
		});
		expect(drilldown.answers.get('location')).toEqual(['store-a']);
		expect(drilldown.answers.get('job')).toEqual(['cashier', 'stocker']);
		expect([...drilldown.agitations]).toEqual(['equipment']);
		expect(populationIds(workers, drilldown)).toEqual(['drew', 'erin']);
	});

	it('reads a remainder beside a selected answer as the conjunctive exact reading', () => {
		const filtered = emptyFilters({
			answers: new Map([['location', ['central']]]),
			exactAnswers: new Map([['location', ['store-a']]])
		});
		const drilldown = groupDrilldownFilters(filtered, location, {
			attributeId: 'location',
			answerId: 'central'
		});
		expect(drilldown.answers.get('location')).toBeUndefined();
		expect(drilldown.exactAnswers.get('location')).toEqual(['store-a']);
		expect(populationIds(workers, drilldown)).toEqual(['drew', 'erin']);
	});

	const departmentWorkers = [
		worker('casey', { department: 'dept-central' }),
		worker('drew', { department: 'dept-store-a' }),
		worker('nina', {})
	];
	const departmentFilter = (answerId: string) =>
		emptyFilters({ answers: new Map([['department', [answerId]]]) });

	it('narrows ordinary Attribute rows the same way', () => {
		// A parent row above the active child keeps the child filter.
		expect(
			drilldownCohort(departmentWorkers, departmentFilter('dept-store-a'), department, {
				attributeId: 'department',
				answerId: 'dept-central'
			})
		).toEqual(['drew']);
		// A row inside the active parent is the narrower predicate.
		expect(
			drilldownCohort(departmentWorkers, departmentFilter('dept-central'), department, {
				attributeId: 'department',
				answerId: 'dept-store-a'
			})
		).toEqual(['drew']);
		// A disjoint row opens nobody.
		expect(
			drilldownCohort(departmentWorkers, departmentFilter('dept-store-a'), department, {
				attributeId: 'department',
				answerId: 'dept-remote'
			})
		).toEqual([]);
	});

	it('intersects ordinary Attribute remainders and gaps', () => {
		const remainder = { attributeId: 'department', answerId: 'dept-central', remainder: true };
		expect(
			drilldownCohort(departmentWorkers, departmentFilter('dept-central'), department, remainder)
		).toEqual(['casey']);
		expect(
			drilldownCohort(departmentWorkers, departmentFilter('dept-store-a'), department, remainder)
		).toEqual([]);

		const gap = { attributeId: 'department', answerId: '', noValue: true };
		const gapFilter = emptyFilters({ missing: new Set(['department']) });
		expect(drilldownCohort(departmentWorkers, gapFilter, department, gap)).toEqual(['nina']);
		expect(
			drilldownCohort(departmentWorkers, departmentFilter('dept-central'), department, gap)
		).toEqual([]);
	});
});

const agitationPopulation: Worker[] = [
	worker('alex', { location: ['store-a'], job: 'cashier' }, ['equipment']),
	worker('blair', { location: ['store-a', 'store-b'], job: 'cashier' }, ['equipment', 'schedule']),
	worker('casey', { location: ['central'] }, ['equipment']),
	worker('drew', { location: ['store-a'], job: 'cashier' }, ['equipment']),
	worker('gray', {}, ['equipment']),
	worker('erin', { location: ['store-b'], job: 'stocker' }, ['equipment'])
];

function agitationCohort(
	filters: WorkerFilters,
	attribute: WorkerAttributeDefinition | undefined,
	group: Parameters<typeof agitationDrilldownFilters>[2],
	agitationId: string
): string[] {
	const drilldown = agitationDrilldownFilters(filters, attribute, group, agitationId);
	return selectWorkerPopulation(
		agitationPopulation,
		[location, job, department],
		populationFilters(drilldown)
	)
		.workers.filter((entry) => entry.agitations.includes(agitationId))
		.map((entry) => entry.id)
		.sort();
}

describe('Overview Agitation drilldowns', () => {
	it('keeps a descendant Location filter when the displayed group is its parent region', () => {
		// Store A is the active filter, so the Central group reads only the Store A
		// holders (Alex, Blair, Drew) and its Equipment link must not reopen Casey,
		// who holds Central itself.
		const filters = emptyFilters({
			answers: new Map([['location', ['store-a']]])
		});
		expect(
			agitationCohort(
				filters,
				location,
				{ attributeId: 'location', answerId: 'central' },
				'equipment'
			)
		).toEqual(['alex', 'blair', 'drew']);
	});

	it('keeps the current context and replaces this Attribute with the displayed group', () => {
		const filters = emptyFilters({
			answers: new Map([['location', ['store-b']]])
		});
		// Blair is the only Store B Cashier holding Equipment; Erin is a Store B
		// Stocker, so the Cashier group cannot reopen her cohort.
		expect(
			agitationCohort(filters, job, { attributeId: 'job', answerId: 'cashier' }, 'equipment')
		).toEqual(['blair']);

		// The same predicates survive the Workers address encoding.
		const drilldown = agitationDrilldownFilters(
			filters,
			job,
			{ attributeId: 'job', answerId: 'cashier' },
			'equipment'
		);
		const reparsed = parseWorkerFilters(
			writeWorkerFilters(new URLSearchParams(), drilldown),
			[location, job, department],
			[{ id: 'equipment', text: 'Equipment' }]
		);
		expect(reparsed.answers.get('location')).toEqual(['store-b']);
		expect(reparsed.answers.get('job')).toEqual(['cashier']);
		expect([...reparsed.agitations]).toEqual(['equipment']);
		expect(
			selectWorkerPopulation(
				agitationPopulation,
				[location, job, department],
				populationFilters(reparsed)
			)
				.workers.filter((entry) => entry.agitations.includes('equipment'))
				.map((entry) => entry.id)
				.sort()
		).toEqual(['blair']);
	});

	it('keeps only the current context for a flat row', () => {
		const filters = emptyFilters({
			answers: new Map([['location', ['store-b']]])
		});
		expect(agitationCohort(filters, undefined, undefined, 'equipment')).toEqual(['blair', 'erin']);
	});

	it('opens a direct-parent remainder as the exact parent, not its subtree', () => {
		expect(
			agitationCohort(
				emptyFilters(),
				location,
				{ attributeId: 'location', answerId: 'central', remainder: true },
				'equipment'
			)
		).toEqual(['casey']);
	});

	it('opens the no-value group as its distinct predicate', () => {
		expect(
			agitationCohort(
				emptyFilters(),
				job,
				{ attributeId: 'job', answerId: '', noValue: true },
				'equipment'
			)
		).toEqual(['casey', 'gray']);
		expect(
			agitationCohort(
				emptyFilters(),
				location,
				{ attributeId: 'location', answerId: '', noValue: true },
				'equipment'
			)
		).toEqual(['gray']);
	});
});
