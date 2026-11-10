// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';
import { mapTableRows, sortMapTableRows } from './map-table-model.ts';
import { answerIdOf, answerIdsFixture, attributeFixture } from './answer-fixtures.ts';
import type { GroupingReading } from './map-grouping.ts';

const languages = [
	{ id: 'la1', name: 'English' },
	{ id: 'la2', name: 'Spanish' }
];

const department = attributeFixture({
	id: 'department',
	name: 'Department',
	kind: 'category',
	options: ['Shipping', 'Support']
});
const nodes: WorkerGraphNode[] = [
	{
		id: 'zoe',
		name: 'Zoe',
		assessment: 'Supporter',
		attributes: answerIdsFixture({ department: 'Shipping' }),
		relationshipCount: 2
	},
	{ id: 'amy', name: 'Amy', assessment: 'Leader', attributes: {}, relationshipCount: 2 },
	{
		id: 'bea',
		name: 'Bea',
		assessment: 'Supporter',
		attributes: answerIdsFixture({ department: 'Shipping' }),
		relationshipCount: 1
	},
	{
		id: 'cal',
		name: 'Cal',
		assessment: 'Activist',
		attributes: answerIdsFixture({ department: 'Support' }),
		relationshipCount: 1
	}
];
const links: WorkerGraphLink[] = [
	{ id: 'amy-zoe', source: 'amy', target: 'zoe', value: 1 },
	{ id: 'zoe-bea', source: 'zoe', target: 'bea', value: 1 },
	{ id: 'bea-cal', source: 'bea', target: 'cal', value: 1 }
];

describe('mapTableRows', () => {
	it('defaults to alphabetical order', () => {
		expect(mapTableRows(nodes, links).map(({ name }) => name)).toEqual([
			'Amy',
			'Bea',
			'Cal',
			'Zoe'
		]);
	});

	it('counts ties outside the worker group', () => {
		const rows = mapTableRows(nodes, links, department);
		expect(rows.find(({ id }) => id === 'bea')?.tiesOutsideGroup).toBe(1);
		expect(rows.find(({ id }) => id === 'zoe')?.tiesOutsideGroup).toBe(1);
	});

	it('counts ties to Leaders', () => {
		const rows = mapTableRows(nodes, links);
		expect(rows.find(({ id }) => id === 'zoe')?.tiesToLeaders).toBe(1);
		expect(rows.find(({ id }) => id === 'bea')?.tiesToLeaders).toBe(0);
	});

	it('names an absent answer by the no-value reading', () => {
		const row = mapTableRows(nodes, links, department).find(({ id }) => id === 'amy');
		expect(row?.group).toBe('No Department');
		expect(row?.groupDescription).toBeNull();
	});

	it('adds No selection only to the system reading when a real answer reads the same', () => {
		const colliding = attributeFixture({
			id: 'department',
			name: 'Department',
			kind: 'category',
			options: ['Shipping', 'No Department']
		});
		const collidingNodes: WorkerGraphNode[] = [
			{ id: 'amy', name: 'Amy', assessment: 'Leader', attributes: {}, relationshipCount: 0 },
			{
				id: 'zoe',
				name: 'Zoe',
				assessment: 'Supporter',
				attributes: answerIdsFixture({ department: 'No Department' }),
				relationshipCount: 0
			}
		];

		const rows = mapTableRows(collidingNodes, [], colliding);
		expect(rows.find(({ id }) => id === 'amy')).toMatchObject({
			group: 'No Department',
			groupDescription: 'No selection'
		});
		// The real answer keeps its own text and gains no secondary description.
		expect(rows.find(({ id }) => id === 'zoe')).toMatchObject({
			group: 'No Department',
			groupDescription: null
		});
	});

	it('names an absent sub-group by the no-value reading', () => {
		const role = attributeFixture({
			id: 'role',
			name: 'Role',
			kind: 'category',
			options: ['Server']
		});
		const rows = mapTableRows(nodes, links, department, role);
		expect(rows.find(({ id }) => id === 'amy')).toMatchObject({
			subGroup: 'No Role',
			subGroupDescription: null
		});
	});

	it('sets outside-group count to zero without a grouping', () => {
		expect(mapTableRows(nodes, links).every(({ tiesOutsideGroup }) => tiesOutsideGroup === 0)).toBe(
			true
		);
	});

	it('Product gap 11 lists recorded Languages in vocabulary order, or says none', () => {
		const rows = mapTableRows(
			[
				{ ...nodes[0], id: 'alex', name: 'Alex', languages: ['la1'] },
				{ ...nodes[1], id: 'casey', name: 'Casey', languages: ['la2', 'la1'] },
				{ ...nodes[2], id: 'drew', name: 'Drew', languages: [] }
			],
			[],
			undefined,
			undefined,
			languages
		);

		expect(rows.find(({ id }) => id === 'alex')?.languages).toBe('English');
		// The node's recorded order does not decide the reading; vocabulary order does.
		expect(rows.find(({ id }) => id === 'casey')?.languages).toBe('English, Spanish');
		expect(rows.find(({ id }) => id === 'drew')?.languages).toBe('No languages recorded.');
	});

	it('marks a row as matching the highlight only when its Worker is in highlightIds', () => {
		const rows = mapTableRows(
			[
				{ ...nodes[0], id: 'alex', name: 'Alex' },
				{ ...nodes[1], id: 'blair', name: 'Blair' },
				{ ...nodes[2], id: 'casey', name: 'Casey' }
			],
			[],
			undefined,
			undefined,
			languages,
			new Set(['blair'])
		);

		expect(rows.find(({ id }) => id === 'blair')?.matchesHighlight).toBe(true);
		expect(rows.find(({ id }) => id === 'alex')?.matchesHighlight).toBe(false);
		expect(rows.find(({ id }) => id === 'casey')?.matchesHighlight).toBe(false);
	});

	it('marks no row when there is no complete highlight query', () => {
		const rows = mapTableRows(nodes, links, undefined, undefined, languages, undefined);
		expect(rows.every(({ matchesHighlight }) => matchesHighlight === false)).toBe(true);
	});

	it('marks no row when the highlight selects nobody', () => {
		const rows = mapTableRows(nodes, links, undefined, undefined, languages, new Set());
		expect(rows.every(({ matchesHighlight }) => matchesHighlight === false)).toBe(true);
	});

	it('names no highlight in the Languages cell', () => {
		const rows = mapTableRows(
			[{ ...nodes[1], id: 'blair', name: 'Blair', languages: ['la1', 'la2'] }],
			[],
			undefined,
			undefined,
			languages,
			new Set(['blair'])
		);

		expect(rows[0]?.languages).toBe('English, Spanish');
	});
});

describe('sortMapTableRows', () => {
	it('breaks equal-value ties by name', () => {
		const rows = mapTableRows(nodes, links, department);
		const sorted = sortMapTableRows(rows, { column: 'relationships', direction: 'desc' });
		expect(
			sorted.filter(({ relationships }) => relationships === 2).map(({ name }) => name)
		).toEqual(['Amy', 'Zoe']);
	});
});

describe('mapTableRows with a paired Sub-grouping reading', () => {
	it('takes the sub-group and its collision description from the reading', () => {
		const team = attributeFixture({
			id: 'team',
			name: 'Team',
			kind: 'category',
			options: ['Alpha', 'Beta', 'No Team']
		});
		const reading: GroupingReading = {
			status: 'available',
			attributeId: department.id,
			regions: [
				{
					key: answerIdOf('department', 'Shipping'),
					identity: 'answer',
					label: 'Shipping',
					description: null,
					outlined: true
				}
			],
			regionOf: new Map([['zoe', { group: answerIdOf('department', 'Shipping'), subGroup: '' }]]),
			membersOf: new Map(),
			counts: new Map(),
			subGrouping: {
				status: 'available',
				attributeId: 'team',
				regions: [
					{
						key: '',
						identity: 'no-value',
						label: 'No Team',
						description: 'No selection',
						outlined: false
					}
				],
				regionOf: new Map([['zoe', '']]),
				membersOf: new Map(),
				counts: new Map()
			}
		};

		const [row] = mapTableRows(
			nodes.filter(({ id }) => id === 'zoe'),
			[],
			department,
			team,
			[],
			undefined,
			reading
		);

		expect(row.group).toBe('Shipping');
		expect(row.groupDescription).toBeNull();
		expect(row.subGroup).toBe('No Team');
		expect(row.subGroupDescription).toBe('No selection');
	});
});

describe('E2 mapping table (e2e migration)', () => {
	it('lists one alphabetical row per drawn worker, naming the no-value group', () => {
		// e2e/mapping-table.spec.ts › table lists every drawn worker.
		const team = attributeFixture({
			id: 'team',
			name: 'Team',
			kind: 'category',
			options: ['Shipping', 'Support']
		});
		const nodes: WorkerGraphNode[] = [
			{
				id: 'ada',
				name: 'Ada',
				assessment: 'Leader',
				attributes: answerIdsFixture({ team: 'Shipping' }),
				relationshipCount: 1
			},
			{
				id: 'bo',
				name: 'Bo',
				assessment: 'Supporter',
				attributes: answerIdsFixture({ team: 'Shipping' }),
				relationshipCount: 1
			},
			{ id: 'cy', name: 'Cy', assessment: 'Hostile', attributes: {}, relationshipCount: 0 }
		];
		const links: WorkerGraphLink[] = [{ id: 'ada-bo', source: 'ada', target: 'bo', value: 1 }];

		const rows = mapTableRows(nodes, links, team);

		expect(rows.map(({ name }) => name)).toEqual(['Ada', 'Bo', 'Cy']);
		expect(rows.map(({ group }) => group)).toEqual(['Shipping', 'Shipping', 'No Team']);
		expect(rows.map(({ relationships }) => relationships)).toEqual([1, 1, 0]);
	});
});
