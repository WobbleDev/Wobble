import { describe, expect, it } from 'vitest';
import type {
	Agitation,
	AssessmentOption,
	Worker,
	WorkerAttributeDefinition
} from '../../domain-vocabulary.ts';
import { selectWorkerPopulation } from '../../shared/worker-population.ts';
import { worker as baseWorker } from '../../testing/builders.ts';
import {
	contextualAgitationsByGroup,
	contextualGroupReadings,
	coverageReading,
	groupReadings
} from './support-summary.ts';

const worker = (
	name: string,
	assessment: AssessmentOption,
	attributes: Record<string, string | string[]> = {},
	agitations: string[] = []
) =>
	baseWorker({
		id: name.toLowerCase().replaceAll(' ', '-'),
		name,
		assessment,
		attributes,
		agitations
	});

const locationId = 'location';
const jobId = 'job';
const shiftId = 'shift';

/** Location is a Multi-Select Attribute, so one Worker can hold several places. */
const location: WorkerAttributeDefinition = {
	id: locationId,
	name: 'Location',
	kind: 'tag',
	answers: [
		{ id: 'central', value: 'Central' },
		{ id: 'store-a', value: 'Store A', parentId: 'central' },
		{ id: 'store-b', value: 'Store B', parentId: 'central' },
		{ id: 'distribution', value: 'Distribution' }
	]
};

const job: WorkerAttributeDefinition = {
	id: jobId,
	name: 'Job',
	kind: 'category',
	answers: [
		{ id: 'cashier', value: 'Cashier' },
		{ id: 'stocker', value: 'Stocker' }
	]
};

const shift: WorkerAttributeDefinition = {
	id: shiftId,
	name: 'Shift',
	kind: 'tag',
	answers: [
		{ id: 'days', value: 'Days' },
		{ id: 'nights', value: 'Nights' }
	]
};

const attributes = [location, job, shift];

/**
 * The contextual fixture: Alex (Activist) works Store A and Store B, Blair
 * (Supporter) works Store A, Casey (Unassessed) holds an empty Location list, and
 * Drew (Disengaged) records Central itself. Alex's two places are one Worker under
 * Central, never two.
 */
function verificationWorkers(): Worker[] {
	return [
		worker('Alex', 'Activist', { [locationId]: ['store-a', 'store-b'], [jobId]: 'cashier' }),
		worker('Blair', 'Supporter', { [locationId]: ['store-a'], [jobId]: 'cashier' }),
		worker('Casey', 'Unassessed', { [locationId]: [], [jobId]: 'cashier' }),
		worker('Drew', 'Disengaged', { [locationId]: ['central'], [jobId]: 'stocker' })
	];
}

describe('contextualGroupReadings', () => {
	it('groups only the Workers the filter selected', () => {
		const cashiers = selectWorkerPopulation(verificationWorkers(), attributes, {
			answers: new Map([[jobId, ['cashier']]])
		});

		// Drew is a Stocker, so his Central record cannot reach the reading; Alex's
		// two places still make him one Worker in the Central group.
		const rows = contextualGroupReadings(cashiers, location);
		expect(rows.map((row) => [row.value, row.total, row.support])).toEqual([
			['Central', 2, 2],
			['No Location', 1, 0]
		]);
		expect(rows[1].counts.Unassessed).toBe(1);
		expect(rows[0].needed).toBe(1);
		expect(rows[1].needed).toBe(1);
	});

	it('counts a Worker once in a group even when several of its answers reach it', () => {
		const erin = worker('Erin', 'Supporter', {
			[locationId]: ['store-a', 'store-b'],
			[jobId]: 'stocker'
		});
		const workers = [...verificationWorkers(), erin];
		const projection = selectWorkerPopulation(workers, attributes);

		// Alex and Erin each hold both children of Central; the parent group still
		// holds four distinct Workers, and each Agitation counts a holder once.
		const rows = contextualGroupReadings(projection, location);
		expect(rows.find((row) => row.value === 'Central')).toMatchObject({
			total: 4,
			support: 3
		});
	});

	it('includes the descendants of a coarse answer and expands into children and an exact remainder', () => {
		const projection = selectWorkerPopulation(verificationWorkers(), attributes);
		const roots = contextualGroupReadings(projection, location);
		expect(roots.map((row) => [row.value, row.total])).toEqual([
			['Central', 3],
			['No Location', 1]
		]);

		const expanded = contextualGroupReadings(projection, location, 5, ['central']);
		expect(expanded.map((row) => [row.value, row.total, row.remainder ?? false])).toEqual([
			['Store A', 2, false],
			['Store B', 1, false],
			['Central', 1, true],
			['No Location', 1, false]
		]);
		expect(expanded[2].description).toBe('this group only');
	});

	it('computes each group target independently instead of summing local needs', () => {
		const workers = [
			...Array.from({ length: 6 }, (_, index) =>
				worker(`Cashier ${index}`, 'Supporter', {
					[locationId]: ['store-a'],
					[jobId]: 'cashier'
				})
			),
			...Array.from({ length: 4 }, (_, index) =>
				worker(`Stocker ${index}`, 'Supporter', {
					[locationId]: ['store-b'],
					[jobId]: 'stocker'
				})
			)
		];
		const projection = selectWorkerPopulation(workers, attributes);
		const rows = contextualGroupReadings(projection, job);
		expect(rows.map((row) => [row.value, row.total, row.needed])).toEqual([
			['Cashier', 6, 2],
			['Stocker', 4, 1]
		]);
		// The Worksite target is its own reading: ten Workers need two Leaders, not
		// the three a sum of local targets would claim.
		expect(coverageReading(workers, 5).needed).toBe(2);
		expect(rows.reduce((total, row) => total + row.needed, 0)).toBe(3);
	});

	it('places a Worker holding no answer in the No reading for either cardinality', () => {
		const frankie = worker('Frankie', 'Supporter', { [jobId]: '' });
		const projection = selectWorkerPopulation([frankie], attributes, {
			missing: new Set([jobId])
		});
		const rows = contextualGroupReadings(projection, job);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			noValue: true,
			value: 'No Job',
			total: 1,
			support: 1
		});
	});

	it('keeps a literal answer named like the no-value reading separate', () => {
		const department: WorkerAttributeDefinition = {
			id: 'department',
			name: 'Department',
			kind: 'category',
			answers: [
				{ id: 'packing', value: 'Packing' },
				{ id: 'literal-none', value: 'No Department' }
			]
		};
		const workers = [
			worker('Alex', 'Leader', { department: 'packing' }),
			worker('Bea', 'Supporter', {}),
			worker('Cory', 'Activist', { department: 'literal-none' })
		];
		const rows = contextualGroupReadings(selectWorkerPopulation(workers, [department]), department);
		expect(rows.map((row) => [row.value, row.total, row.noValue ?? false])).toEqual([
			['Packing', 1, false],
			['No Department', 1, false],
			['No Department', 1, true]
		]);
	});
});

describe('groupReadings hierarchy', () => {
	it('includes descendants in a coarse group', () => {
		const department: WorkerAttributeDefinition = {
			id: 'department',
			name: 'Department',
			kind: 'category',
			answers: [
				{ id: 'central', value: 'Central' },
				{ id: 'store-a', value: 'Store A', parentId: 'central' }
			]
		};
		const workers = [
			worker('Casey', 'Supporter', { department: 'central' }),
			worker('Drew', 'Leader', { department: 'store-a' })
		];
		const rows = groupReadings(workers, department);
		expect(rows.map((row) => [row.value, row.total])).toEqual([['Central', 2]]);

		const expanded = groupReadings(workers, department, 5, ['central']);
		expect(expanded.map((row) => [row.value, row.total, row.remainder ?? false])).toEqual([
			['Store A', 1, false],
			['Central', 1, true]
		]);
	});
});

const equipment: Agitation = { id: 'equipment', text: 'Equipment' };
const schedule: Agitation = { id: 'schedule', text: 'Schedule' };
const pay: Agitation = { id: 'pay', text: 'Pay' };
const agitationList = [equipment, schedule, pay];

/**
 * The Agitations fixture: Alex works Store A and Store B and holds Equipment;
 * Blair works Store A and holds Equipment and Schedule; Casey records Central with
 * no Job and holds Equipment; Drew records Central itself and holds Pay; Gray holds
 * no Location but does hold Equipment; Erin works Store B as a Stocker and holds
 * Equipment.
 */
function agitationWorkers(): Worker[] {
	return [
		worker('Alex', 'Activist', { [locationId]: ['store-a', 'store-b'], [jobId]: 'cashier' }, [
			'equipment'
		]),
		worker('Blair', 'Supporter', { [locationId]: ['store-a'], [jobId]: 'cashier' }, [
			'equipment',
			'schedule'
		]),
		worker('Casey', 'Unassessed', { [locationId]: ['central'] }, ['equipment']),
		worker('Drew', 'Leader', { [locationId]: ['central'], [jobId]: 'cashier' }, ['pay']),
		worker('Gray', 'Supporter', {}, ['equipment']),
		worker('Erin', 'Activist', { [locationId]: ['store-b'], [jobId]: 'stocker' }, ['equipment'])
	];
}

describe('contextualAgitationsByGroup', () => {
	it('counts a Worker once per group and once per held Agitation, even with several answers', () => {
		const projection = selectWorkerPopulation(agitationWorkers(), attributes);
		const groups = contextualAgitationsByGroup(projection, agitationList, job);

		expect(
			groups.map((group) => [group.value, group.workers, group.held, group.noValue ?? false])
		).toEqual([
			['Cashier', 3, 3, false],
			['Stocker', 1, 1, false],
			['No Job', 2, 1, true]
		]);
		// Alex holds two Locations but is one Cashier; each held Agitation counts him
		// once inside the group.
		const cashier = groups[0];
		expect(cashier.agitations.map((row) => [row.text, row.count])).toEqual([
			['Equipment', 2],
			['Schedule', 1],
			['Pay', 1]
		]);
		expect(groups[1].agitations).toEqual([{ id: 'equipment', text: 'Equipment', count: 1 }]);
		expect(groups.reduce((total, group) => total + group.workers, 0)).toBe(
			projection.workers.length
		);
	});

	it('reads only the Workers the filtered context selected', () => {
		const storeB = selectWorkerPopulation(agitationWorkers(), attributes, {
			answers: new Map([[locationId, ['store-b']]])
		});
		const groups = contextualAgitationsByGroup(storeB, agitationList, job);

		expect(groups.map((group) => [group.value, group.workers])).toEqual([
			['Cashier', 1],
			['Stocker', 1]
		]);
		expect(groups.map((group) => group.agitations.map((row) => row.text))).toEqual([
			['Equipment'],
			['Equipment']
		]);
	});

	it('includes Unassessed Workers in each group denominator and omits a group with no Agitation', () => {
		const projection = selectWorkerPopulation(agitationWorkers(), attributes);
		const groups = contextualAgitationsByGroup(projection, agitationList, location);
		const central = groups.find((group) => group.value === 'Central');
		// Casey is Unassessed and holds Equipment, so she stays in the denominator and
		// the Equipment count.
		expect(central).toMatchObject({ workers: 5, held: 3 });
		expect(central?.agitations.map((row) => [row.text, row.count])).toEqual([
			['Equipment', 4],
			['Schedule', 1],
			['Pay', 1]
		]);

		const stockers = selectWorkerPopulation(agitationWorkers(), attributes, {
			answers: new Map([[jobId, ['stocker']]])
		});
		expect(contextualAgitationsByGroup(stockers, [pay], location)).toEqual([]);
	});

	it('reads the same branches and exact remainders as the Support breakdown', () => {
		const hierarchy: WorkerAttributeDefinition = {
			...location,
			answers: [
				{ id: 'central', value: 'Central' },
				{ id: 'store-a', value: 'Store A', parentId: 'central' },
				{ id: 'store-b', value: 'Store B', parentId: 'central' }
			]
		};
		const workers = [
			worker('Casey', 'Supporter', { [hierarchy.id]: ['central'] }, ['equipment']),
			worker('Drew', 'Leader', { [hierarchy.id]: ['store-a'] }, ['equipment']),
			worker('Erin', 'Activist', { [hierarchy.id]: ['central', 'store-a'] }, ['schedule'])
		];
		const expanded = ['central'];
		const projection = selectWorkerPopulation(workers, [hierarchy]);
		const support = contextualGroupReadings(projection, hierarchy, 5, expanded);
		const groups = contextualAgitationsByGroup(projection, agitationList, hierarchy, expanded);

		// One frontier, one membership: each Agitation group reads the same cohort the
		// Support row counts, including the occupied direct-parent remainder.
		expect(groups.map((group) => [group.value, group.workers, group.remainder ?? false])).toEqual(
			support.map((row) => [row.value, row.total, row.remainder ?? false])
		);
		expect(groups.map((group) => group.description)).toEqual(support.map((row) => row.description));
		const remainder = groups.find((group) => group.remainder);
		expect(remainder).toMatchObject({
			answerId: 'central',
			value: 'Central',
			description: 'this group only',
			workers: 2
		});
		expect(remainder?.agitations).toEqual([
			{ id: 'equipment', text: 'Equipment', count: 1 },
			{ id: 'schedule', text: 'Schedule', count: 1 }
		]);
		expect(groups.find((group) => group.answerId === 'store-a')).toMatchObject({ workers: 2 });
	});

	it('caps each group and keeps the held count independent of the cap', () => {
		const projection = selectWorkerPopulation(agitationWorkers(), attributes);
		const [cashier] = contextualAgitationsByGroup(projection, agitationList, job, [], 1);
		expect(cashier.agitations).toHaveLength(1);
		expect(cashier.held).toBe(3);
	});

	it('returns nothing without an Attribute', () => {
		const projection = selectWorkerPopulation(agitationWorkers(), attributes);
		expect(contextualAgitationsByGroup(projection, agitationList, undefined)).toEqual([]);
	});
});
