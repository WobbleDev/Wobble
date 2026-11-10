import { describe, expect, it } from 'vitest';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import {
	answerLabels,
	assessmentCounts,
	agitationReadings,
	agitationsByCategory,
	coverageReading,
	groupReadings,
	holdsAnswer,
	leaderTarget,
	supportReading
} from './support-summary.ts';
import type {
	Agitation,
	AssessmentOption,
	WorkerAttributeDefinition
} from '../../domain-vocabulary.ts';

/** Answers are given by id (ADR 0030): a string for a Category, a list for a Tag. */
const worker = (
	name: string,
	assessment: AssessmentOption,
	answers: Record<string, string | string[]> = {},
	agitations: string[] = []
) =>
	baseWorker({
		id: name.toLowerCase(),
		name,
		assessment,
		attributes: answers,
		agitations
	});

const department: WorkerAttributeDefinition = {
	id: 'department',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'front-of-house', value: 'Front of House' },
		{ id: 'back-of-house', value: 'Back of House' },
		{ id: 'unused', value: 'Unused' }
	]
};

describe('answer ids', () => {
	it('reads a holder by id and labels the answer from its current text', () => {
		const holder = worker('Ari', 'Leader', { department: 'front-of-house' });
		expect(holdsAnswer(holder, 'department', 'front-of-house')).toBe(true);
		expect(holdsAnswer(holder, 'department', 'back-of-house')).toBe(false);
		expect(answerLabels(holder, department)).toBe('Front of House');
	});

	it('labels a Tag holder with each held answer, in its order', () => {
		const tag: WorkerAttributeDefinition = {
			...department,
			id: 'shifts',
			kind: 'tag',
			answers: [
				{ id: 'nights', value: 'Nights' },
				{ id: 'days', value: 'Days' }
			]
		};
		const holder = worker('Bea', 'Supporter', { shifts: ['days', 'nights'] });
		expect(answerLabels(holder, tag)).toEqual(['Days', 'Nights']);
		expect(holdsAnswer(holder, 'shifts', 'nights')).toBe(true);
	});
});

describe('assessmentCounts', () => {
	it('counts each standing, including the ones a Workers table does not hold', () => {
		const counts = assessmentCounts([worker('Ari', 'Leader'), worker('Bea', 'Hostile')]);
		expect(counts).toEqual({
			Unassessed: 0,
			Leader: 1,
			Activist: 0,
			Supporter: 0,
			Disengaged: 0,
			Hostile: 1
		});
	});
});

describe('supportReading', () => {
	it('reads Leader, Activist and Supporter as support over the whole population', () => {
		const reading = supportReading([
			worker('Ari', 'Leader'),
			worker('Bea', 'Activist'),
			worker('Cory', 'Supporter'),
			worker('Dee', 'Disengaged'),
			worker('Eli', 'Hostile'),
			worker('Finn', 'Unassessed')
		]);
		expect(reading).toEqual({ support: 3, total: 6, rate: 0.5 });
	});

	it('reports a zero rate for an empty population', () => {
		expect(supportReading([])).toEqual({ support: 0, total: 0, rate: 0 });
	});
});

describe('groupReadings', () => {
	const workers = [
		worker('Ari', 'Leader', { department: 'front-of-house' }),
		worker('Bea', 'Supporter', { department: 'front-of-house' }),
		worker('Cory', 'Disengaged', { department: 'front-of-house' }),
		worker('Dee', 'Activist', { department: 'back-of-house' })
	];

	it('reads most to least support and drops empty values, with no whole row', () => {
		// Back of House is all support (1 of 1); Front of House is 2 of 3.
		expect(groupReadings(workers, department).map((row) => row.value)).toEqual([
			'Back of House',
			'Front of House'
		]);
	});

	it('keeps configured order for rows at equal support', () => {
		const tied = [
			worker('Ari', 'Leader', { department: 'front-of-house' }),
			worker('Bea', 'Leader', { department: 'back-of-house' })
		];
		expect(groupReadings(tied, department).map((row) => row.value)).toEqual([
			'Front of House',
			'Back of House'
		]);
	});

	it('reads support, Leaders and counts over each group', () => {
		const front = groupReadings(workers, department).find((row) => row.value === 'Front of House')!;
		expect(front).toMatchObject({ support: 2, total: 3, rate: 2 / 3, leaders: 1 });
		expect(front.counts).toMatchObject({ Leader: 1, Supporter: 1, Disengaged: 1, Hostile: 0 });
	});

	it('rounds needed up and signs the gap', () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			worker(`W${i}`, 'Supporter', { department: 'front-of-house' })
		);
		many.push(worker('L', 'Leader', { department: 'front-of-house' }));
		const [row] = groupReadings(many, department, 5);
		expect(row).toMatchObject({ leaders: 1, needed: 3, gap: -2 });
		expect(
			groupReadings(workers, department, 5).find((row) => row.value === 'Front of House')
		).toMatchObject({ needed: 1, gap: 0 });
		const surplus = [
			worker('A', 'Leader', { department: 'front-of-house' }),
			worker('B', 'Leader', { department: 'front-of-house' })
		];
		expect(groupReadings(surplus, department, 5)[0].gap).toBe(1);
	});

	it('reads each row over its own group rather than the whole population', () => {
		// Front of House holds three of the four workers; the whole reading is the
		// coverage sheet's, not a row in the list.
		const front = groupReadings(workers, department).find((row) => row.value === 'Front of House')!;
		expect(front.total).toBe(3);
		expect(groupReadings(workers, department).some((row) => row.value === 'Whole worksite')).toBe(
			false
		);
	});

	it('falls back to a target of five', () => {
		const ten = Array.from({ length: 10 }, (_, i) =>
			worker(`W${i}`, 'Supporter', { department: 'front-of-house' })
		);
		expect(groupReadings(ten, department, 0)[0].needed).toBe(2);
		expect(groupReadings(ten, department)[0].needed).toBe(2);
	});

	it('returns nothing when no Category is given', () => {
		expect(groupReadings(workers, undefined)).toEqual([]);
	});

	it('counts a Worker once in a parent group when it holds several descendants', () => {
		const location: WorkerAttributeDefinition = {
			id: 'location',
			name: 'Location',
			kind: 'tag',
			answers: [
				{ id: 'central', value: 'Central' },
				{ id: 'store-a', value: 'Store A', parentId: 'central' },
				{ id: 'store-b', value: 'Store B', parentId: 'central' }
			]
		};
		const both = worker('Ari', 'Leader', { location: ['store-a', 'store-b'] });
		const one = worker('Bea', 'Supporter', { location: ['store-a'] });
		const parent = worker('Cory', 'Unassessed', { location: ['central'] });
		const population = [both, one, parent];

		// An unexpanded parent includes both descendants, and Ari is one Worker there.
		expect(groupReadings(population, location)).toEqual([
			expect.objectContaining({ value: 'Central', total: 3, support: 2 })
		]);

		// Expanded, each child counts Ari once in its own group; the remainder is the
		// Worker holding the parent itself, never the parent's subtree.
		expect(
			groupReadings(population, location, 5, ['central']).map((row) => [
				row.value,
				row.total,
				row.remainder ?? false
			])
		).toEqual([
			['Store A', 2, false],
			['Store B', 1, false],
			['Central', 1, true]
		]);
	});
});

describe('leaderTarget', () => {
	it('keeps a positive whole number and falls back to five otherwise', () => {
		expect(leaderTarget(2)).toBe(2);
		expect(leaderTarget(1)).toBe(1);
		expect(leaderTarget(100)).toBe(100);
		expect(leaderTarget(0)).toBe(5);
		expect(leaderTarget(-3)).toBe(5);
		expect(leaderTarget(1.5)).toBe(5);
		expect(leaderTarget(Number.NaN)).toBe(5);
	});
});

describe('coverageReading', () => {
	it('reads Leaders, needed and the signed gap over the whole Workers table', () => {
		expect(coverageReading([worker('L', 'Leader'), worker('S', 'Supporter')])).toEqual({
			leaders: 1,
			needed: 1,
			gap: 0
		});
	});

	it('reads a shortfall: five workers at two per Leader needs three', () => {
		const workers = [
			worker('L', 'Leader'),
			...Array.from({ length: 4 }, (_, i) => worker(`W${i}`, 'Supporter'))
		];
		expect(coverageReading(workers, 2)).toEqual({ leaders: 1, needed: 3, gap: -2 });
	});

	it('reads a surplus: Leaders past the target', () => {
		const workers = Array.from({ length: 4 }, (_, i) => worker(`L${i}`, 'Leader'));
		expect(coverageReading(workers, 5)).toEqual({ leaders: 4, needed: 1, gap: 3 });
	});

	it('reads an empty Workers table as no Leaders and no need', () => {
		expect(coverageReading([])).toEqual({ leaders: 0, needed: 0, gap: 0 });
	});

	it('falls back to a target of five when the target is not a positive whole number', () => {
		const ten = Array.from({ length: 10 }, (_, i) => worker(`W${i}`, 'Supporter'));
		expect(coverageReading(ten, 0)).toEqual(coverageReading(ten));
		expect(coverageReading(ten, 0).needed).toBe(2);
	});
});

const agitations: Agitation[] = [
	{ id: 'pay', text: 'Pay' },
	{ id: 'scheduling', text: 'Scheduling' },
	{ id: 'parking', text: 'Parking' },
	{ id: 'staffing', text: 'Short staffing' }
];

describe('agitationReadings', () => {
	it('lists every held Agitation by count, not cut to three', () => {
		const workers = [
			worker('Ari', 'Leader', {}, ['scheduling']),
			worker('Bea', 'Supporter', {}, ['scheduling']),
			worker('Cory', 'Supporter', {}, ['pay', 'parking']),
			worker('Eli', 'Activist', {}, ['staffing'])
		];
		expect(agitationReadings(workers, agitations).map((r) => r.text)).toEqual([
			'Scheduling',
			'Pay',
			'Parking',
			'Short staffing'
		]);
	});

	it('breaks ties by configured order and drops unheld', () => {
		const workers = [
			worker('Ari', 'Leader', {}, ['parking']),
			worker('Bea', 'Leader', {}, ['pay'])
		];
		expect(agitationReadings(workers, agitations)).toEqual([
			{ id: 'pay', text: 'Pay', count: 1 },
			{ id: 'parking', text: 'Parking', count: 1 }
		]);
	});
});

describe('agitationsByCategory', () => {
	const workers = [
		worker('Ari', 'Leader', { department: 'front-of-house' }, [
			'pay',
			'scheduling',
			'parking',
			'staffing'
		]),
		worker('Bea', 'Leader', { department: 'front-of-house' }, ['pay', 'scheduling']),
		worker('Cory', 'Leader', { department: 'front-of-house' }, ['pay']),
		worker('Dee', 'Leader', { department: 'back-of-house' }, [])
	];

	it('caps each group and counts the remainder via held', () => {
		const [front] = agitationsByCategory(workers, agitations, department);
		expect(front.value).toBe('Front of House');
		expect(front.workers).toBe(3);
		expect(front.agitations.map((r) => r.text)).toEqual(['Pay', 'Scheduling', 'Parking']);
		expect(front.held).toBe(4);
	});

	it('omits groups with no Agitations and honours perGroup', () => {
		const groups = agitationsByCategory(workers, agitations, department, 1);
		expect(groups.map((g) => g.value)).toEqual(['Front of House']);
		expect(groups[0].agitations).toHaveLength(1);
	});

	it('returns nothing without a Category', () => {
		expect(agitationsByCategory(workers, agitations, undefined)).toEqual([]);
	});
});
describe('no-value group for either cardinality', () => {
	it('reads an empty Multi-Select list as the same no-value group', () => {
		const shifts: WorkerAttributeDefinition = {
			id: 'shifts',
			name: 'Shifts',
			kind: 'tag',
			answers: [
				{ id: 'days', value: 'Days' },
				{ id: 'nights', value: 'Nights' }
			]
		};
		const rows = groupReadings(
			[worker('Ari', 'Leader', { shifts: ['days'] }), worker('Bea', 'Supporter', { shifts: [] })],
			shifts
		);
		expect(rows.map((row) => [row.value, row.total, row.noValue ?? false])).toEqual([
			['Days', 1, false],
			['No Shifts', 1, true]
		]);
	});

	it('reads a Single-Select holding the empty answer the same way', () => {
		const rows = groupReadings(
			[
				worker('Ari', 'Leader', { department: 'front-of-house' }),
				worker('Bea', 'Supporter', { department: '' })
			],
			department
		);
		expect(rows.map((row) => [row.value, row.total, row.noValue ?? false])).toEqual([
			['Front of House', 1, false],
			['No Department', 1, true]
		]);
	});
});
describe('Multi-Select breakdown groups', () => {
	it('places a Worker once in each value group and leaves the whole reading unchanged', () => {
		const roles: WorkerAttributeDefinition = {
			id: 'roles',
			name: 'Roles',
			kind: 'tag',
			answers: [
				{ id: 'cashier', value: 'Cashier' },
				{ id: 'stocker', value: 'Stocker' },
				{ id: 'trainer', value: 'Trainer' }
			]
		};
		const population = [
			worker('Ada', 'Leader', { roles: ['cashier', 'stocker'] }),
			worker('Bea', 'Supporter', { roles: ['cashier'] }),
			worker('Cy', 'Unassessed', { roles: [] })
		];

		const rows = groupReadings(population, roles);
		expect(rows.map((row) => [row.value, row.total, row.noValue ?? false])).toEqual([
			['Cashier', 2, false],
			['Stocker', 1, false],
			['No Roles', 1, true]
		]);
		// Ada reaches two groups, but the headline is still the whole Worksite, once.
		expect(supportReading(population)).toEqual({ support: 2, total: 3, rate: 2 / 3 });
	});
});

describe('Product gap 04 — no-value Workers in Support', () => {
	const withNoValue: WorkerAttributeDefinition = {
		id: 'department',
		name: 'Department',
		kind: 'category',
		answers: [
			{ id: 'packing', value: 'Packing' },
			{ id: 'delivery', value: 'Delivery' },
			{ id: 'literal-none', value: 'No Department' }
		]
	};
	const population = [
		worker('Alex', 'Leader', { department: 'packing' }, ['equipment']),
		worker('Blair', 'Supporter', { department: 'delivery' }, ['schedule']),
		worker('Casey', 'Unassessed', {}, ['equipment']),
		worker('Drew', 'Activist', { department: 'literal-none' })
	];

	it('places every Worker once, with the system group last and separate from a literal answer', () => {
		const rows = groupReadings(population, withNoValue);
		expect(rows.map((row) => row.value)).toEqual([
			'Packing',
			'Delivery',
			'No Department',
			'No Department'
		]);
		expect(rows.reduce((total, row) => total + row.total, 0)).toBe(4);

		const literal = rows[2];
		expect(literal).toMatchObject({ answerId: 'literal-none', value: 'No Department', total: 1 });
		expect(literal.noValue).toBeUndefined();
		expect(literal.description).toBeUndefined();

		const system = rows[3];
		expect(system).toMatchObject({
			attributeId: 'department',
			answerId: '',
			noValue: true,
			total: 1
		});
		expect(system.value).toBe('No Department');
		expect(system.description).toBe('No selection');
	});

	it('keeps the whole-Worksite arithmetic unchanged', () => {
		expect(supportReading(population)).toEqual({ support: 3, total: 4, rate: 0.75 });
	});

	it('omits the system group when every Worker holds an answer', () => {
		expect(groupReadings(population.slice(0, 2), withNoValue).map((row) => row.value)).toEqual([
			'Packing',
			'Delivery'
		]);
	});

	it('names the group after the current Attribute and drops a vanished collision', () => {
		const renamed = { ...withNoValue, name: 'Team' };
		const rows = groupReadings(population, renamed);
		expect(rows[3]).toMatchObject({ value: 'No Team', noValue: true });
		expect(rows[3].description).toBeUndefined();
	});
});
describe('Product gap 05 — no-value Workers in grouped Agitations', () => {
	const equipment: Agitation = { id: 'equipment', text: 'Equipment' };
	const schedule: Agitation = { id: 'schedule', text: 'Schedule' };
	const pay: Agitation = { id: 'pay', text: 'Pay' };
	const list: Agitation[] = [equipment, schedule, pay];

	const withNoValue: WorkerAttributeDefinition = {
		id: 'department',
		name: 'Department',
		kind: 'category',
		answers: [
			{ id: 'packing', value: 'Packing' },
			{ id: 'delivery', value: 'Delivery' },
			{ id: 'literal-none', value: 'No Department' }
		]
	};
	const population = [
		worker('Alex', 'Leader', { department: 'packing' }, ['equipment']),
		worker('Blair', 'Supporter', { department: 'delivery' }, ['schedule']),
		worker('Casey', 'Unassessed', {}, ['equipment', 'schedule', 'pay']),
		worker('Drew', 'Activist', { department: 'literal-none' })
	];

	it('shows the no-value group with its Agitations, after the configured groups', () => {
		const groups = agitationsByCategory(population.slice(0, 3), list, withNoValue);
		expect(groups.map((group) => group.value)).toEqual(['Packing', 'Delivery', 'No Department']);
		const system = groups[2];
		expect(system).toMatchObject({
			attributeId: 'department',
			answerId: '',
			noValue: true,
			description: 'No selection',
			workers: 1,
			held: 3
		});
		// Most-held first, then configured order, capped at three.
		expect(system.agitations.map((row) => row.text)).toEqual(['Equipment', 'Schedule', 'Pay']);
	});

	it('omits the group when no missing Worker holds an Agitation', () => {
		// Drew's literal answer group has no Agitations and is omitted; Casey's
		// missing-answer group keeps the Equipment she holds.
		const groups = agitationsByCategory(population, [equipment], withNoValue);
		expect(groups.map((group) => group.value)).toEqual(['Packing', 'No Department']);

		// A missing Worker holding nothing adds no group at all.
		const quiet = agitationsByCategory(
			[worker('Casey', 'Unassessed', {}), ...population.slice(0, 2)],
			[equipment, schedule],
			withNoValue
		);
		expect(quiet.map((group) => group.value)).toEqual(['Packing', 'Delivery']);
	});

	it('keeps the top-item limit inside the no-value group', () => {
		const [system] = agitationsByCategory(population.slice(2, 3), list, withNoValue);
		expect(system.agitations).toHaveLength(3);
		const limited = agitationsByCategory(population.slice(2, 3), list, withNoValue, 1);
		expect(limited[0].agitations.map((row) => row.text)).toEqual(['Equipment']);
		expect(limited[0].held).toBe(3);
	});

	it('keeps a colliding literal answer group separate from the system group', () => {
		const withDrew = population.map((member) =>
			member.name === 'Drew' ? { ...member, agitations: ['pay'] } : member
		);
		const groups = agitationsByCategory(withDrew, list, withNoValue);
		expect(groups.map((group) => group.value)).toEqual([
			'Packing',
			'Delivery',
			'No Department',
			'No Department'
		]);
		const literal = groups[2];
		expect(literal.answerId).toBe('literal-none');
		expect(literal.noValue).toBeUndefined();
		expect(literal.description).toBeUndefined();
		expect(groups[3]).toMatchObject({ noValue: true, description: 'No selection' });
	});
});
