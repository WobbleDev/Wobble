import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test, testId } from './fixtures.ts';
import { waitForMapReady } from './map.ts';
import { selectOnMap } from './person.ts';
import { openWorkers } from './pages.ts';
import { answerId } from './answer-wire.ts';

/**
 * Ticket 21: Mapping filters its Workers through the same ordinary Attribute
 * predicates as the Workers view, while drawing each person once and keeping
 * Relationship meaning. Filters on different Attributes are independent; filters
 * within one Attribute are alternatives.
 *
 * Fixture (the issue's correlation fixture, widened):
 * - Territory (Multi-Select): Downtown with Store A and Store B; Uptown with North Store.
 * - Position (Multi-Select): Cashier, Stocker. Shift (Multi-Select): Days, Nights.
 * - Team (Single-Select): Team A, Team B.
 * - Alex: Store A + Store B, Cashier + Stocker, Days + Nights (Team A).
 * - Grace: Store B, Stocker, Nights (Team B).
 * - Ben: Store B, Cashier, Days + Nights (Team A).
 * - Casey: North Store, Cashier, Days (Team A).
 * - Eli: Downtown, Cashier, Days (Team A), a direct parent holder.
 * - Frankie: Store B, no Position or Shift (Team A).
 * - Dana: no Attribute values (Team B).
 * - Relationships: Alex–Grace, Alex–Ben, Grace–Dana.
 */

type Seeded = {
	ids: {
		territory: string;
		position: string;
		shift: string;
		team: string;
	};
	answers: Record<
		| 'downtown'
		| 'storeA'
		| 'storeB'
		| 'northStore'
		| 'cashier'
		| 'stocker'
		| 'days'
		| 'nights'
		| 'teamA'
		| 'teamB',
		string
	>;
	workers: Record<'alex' | 'grace' | 'ben' | 'casey' | 'eli' | 'frankie' | 'dana', string>;
};

function ids() {
	return {
		territory: 'territory-' + testId(),
		position: 'position-' + testId(),
		shift: 'shift-' + testId(),
		team: 'team-' + testId()
	};
}

async function seed(request: APIRequestContext): Promise<Seeded> {
	const seededIds = ids();
	const { territory, position, shift, team } = seededIds;
	const answers = {
		downtown: answerId(territory, 'Downtown'),
		storeA: answerId(territory, 'Store A'),
		storeB: answerId(territory, 'Store B'),
		northStore: answerId(territory, 'North Store'),
		cashier: answerId(position, 'Cashier'),
		stocker: answerId(position, 'Stocker'),
		days: answerId(shift, 'Days'),
		nights: answerId(shift, 'Nights'),
		teamA: answerId(team, 'Team A'),
		teamB: answerId(team, 'Team B')
	};
	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: territory,
				name: 'Territory',
				kind: 'tag',
				options: [
					{ id: answers.downtown, value: 'Downtown' },
					{ id: answers.storeA, value: 'Store A', parentId: answers.downtown },
					{ id: answers.storeB, value: 'Store B', parentId: answers.downtown },
					{ id: answerId(territory, 'Uptown'), value: 'Uptown' },
					{
						id: answers.northStore,
						value: 'North Store',
						parentId: answerId(territory, 'Uptown')
					}
				]
			},
			{
				id: position,
				name: 'Position',
				kind: 'tag',
				options: [
					{ id: answers.cashier, value: 'Cashier' },
					{ id: answers.stocker, value: 'Stocker' }
				]
			},
			{
				id: shift,
				name: 'Shift',
				kind: 'tag',
				options: [
					{ id: answers.days, value: 'Days' },
					{ id: answers.nights, value: 'Nights' }
				]
			},
			{
				id: team,
				name: 'Team',
				kind: 'category',
				options: [
					{ id: answers.teamA, value: 'Team A' },
					{ id: answers.teamB, value: 'Team B' }
				]
			}
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const people = [
		{
			key: 'alex',
			name: 'Marie Curie',
			attributes: {
				[territory]: [answers.storeA, answers.storeB],
				[position]: [answers.cashier, answers.stocker],
				[shift]: [answers.days, answers.nights],
				[team]: answers.teamA
			}
		},
		{
			key: 'grace',
			name: 'Grace Hopper',
			attributes: {
				[territory]: [answers.storeB],
				[position]: [answers.stocker],
				[shift]: [answers.nights],
				[team]: answers.teamB
			}
		},
		{
			key: 'ben',
			name: 'Isaac Newton',
			attributes: {
				[territory]: [answers.storeB],
				[position]: [answers.cashier],
				[shift]: [answers.days, answers.nights],
				[team]: answers.teamA
			}
		},
		{
			key: 'casey',
			name: 'Carl Sagan',
			attributes: {
				[territory]: [answers.northStore],
				[position]: [answers.cashier],
				[shift]: [answers.days],
				[team]: answers.teamA
			}
		},
		{
			key: 'eli',
			name: 'Pierre Curie',
			// The broad parent answer records Central directly, without a store.
			attributes: {
				[territory]: [answers.downtown],
				[position]: [answers.cashier],
				[shift]: [answers.days],
				[team]: answers.teamA
			}
		},
		{
			key: 'frankie',
			name: 'Otto Hahn',
			// A known store survives while Position and Shift stay empty.
			attributes: {
				[territory]: [answers.storeB],
				[position]: [],
				[shift]: [],
				[team]: answers.teamA
			}
		},
		{
			key: 'dana',
			name: 'Dian Fossey',
			attributes: {
				[territory]: [],
				[position]: [],
				[shift]: [],
				[team]: ''
			}
		}
	] as const;
	const workers = {} as Seeded['workers'];
	for (const person of people) {
		const created = await request.post('/api/workers', {
			data: {
				name: person.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: person.attributes,
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		workers[person.key] = ((await created.json()) as { worker: { id: string } }).worker.id;
	}

	async function relate(first: string, second: string) {
		const related = await request.patch(
			'/api/workers/' + workers[first as keyof Seeded['workers']],
			{
				data: {
					field: 'relationships',
					action: 'add',
					value: { id: workers[second as keyof Seeded['workers']] }
				}
			}
		);
		expect(related.ok(), await related.text()).toBeTruthy();
	}
	await relate('alex', 'grace');
	await relate('alex', 'ben');
	await relate('grace', 'dana');

	return { ids: seededIds, answers, workers };
}

function filterLink(path: string, conditions: Array<[string, string]>): string {
	const params = new URLSearchParams();
	for (const [attributeId, answer] of conditions) params.append('f', attributeId + ':' + answer);
	return path + '?' + params.toString();
}

const nodeIds = (page: Page) =>
	page
		.locator('svg g[role="button"][data-node-id]')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-id') ?? '').sort());

const rowIds = (page: Page) =>
	page
		.locator('[data-map-table-row]')
		.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-map-table-row') ?? '').sort());

const ties = (page: Page) => page.locator('svg path[data-tie]');

async function openMapping(page: Page, path: string): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(path);
	await waitForMapReady(page);
}

test.use({ reducedMotion: 'reduce' });

test('@ticket-21 identical conditions select identical Worker IDs in Workers and Mapping', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	const cases = [
		{
			// Store B + Cashier: the two Attributes are independent, so Alex (who
			// holds Store B and Cashier separately) and Ben both match.
			conditions: [
				[seeded.ids.territory, seeded.answers.storeB],
				[seeded.ids.position, seeded.answers.cashier]
			] as Array<[string, string]>,
			expected: [seeded.workers.alex, seeded.workers.ben].sort()
		},
		{
			conditions: [
				[seeded.ids.territory, seeded.answers.storeB],
				[seeded.ids.position, seeded.answers.stocker],
				[seeded.ids.shift, seeded.answers.nights]
			] as Array<[string, string]>,
			expected: [seeded.workers.alex, seeded.workers.grace].sort()
		},
		{
			// The broad Downtown parent includes its descendant stores and Eli's direct
			// parent answer, but not Casey's North Store.
			conditions: [
				[seeded.ids.territory, seeded.answers.downtown],
				[seeded.ids.position, seeded.answers.cashier]
			] as Array<[string, string]>,
			expected: [seeded.workers.alex, seeded.workers.ben, seeded.workers.eli].sort()
		}
	];

	for (const { conditions, expected } of cases) {
		const workersLink = filterLink('/workers', conditions);
		await openWorkers(page, workersLink);
		await expect(page.locator('tbody tr[data-worker-id]')).toHaveCount(expected.length);
		const workers = await page
			.locator('tbody tr[data-worker-id]')
			.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-worker-id') ?? '').sort());
		expect(workers, 'the Workers view selects the expected literal IDs').toEqual(expected);

		await openMapping(page, workersLink.replace('/workers?', '/mapping?'));
		expect(await nodeIds(page), 'the map draws the same Workers').toEqual(expected);
		expect(await rowIds(page), 'the Map table lists the same Workers').toEqual(expected);
	}
});

test('@ticket-21 several matching values still draw one node and one table row', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openMapping(
		page,
		filterLink('/mapping', [
			[seeded.ids.territory, seeded.answers.storeB],
			[seeded.ids.position, seeded.answers.cashier]
		])
	);

	// Alex and Ben each hold Store B and Cashier; each person is drawn once.
	const expected = [seeded.workers.alex, seeded.workers.ben].sort();
	expect(await nodeIds(page)).toEqual(expected);
	expect(await rowIds(page)).toEqual(expected);
	for (const workerId of expected) {
		await expect(page.locator(`g[data-node-id="${workerId}"]`)).toHaveCount(1);
		await expect(page.locator(`[data-map-table-row="${workerId}"]`)).toHaveCount(1);
	}
});

test('@ticket-21 filtering works in Free layout and existing Worker-level grouping', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openMapping(
		page,
		'/mapping?group=' + seeded.ids.team + '&f=' + seeded.ids.territory + ':' + seeded.answers.storeB
	);

	const expected = [
		seeded.workers.alex,
		seeded.workers.ben,
		seeded.workers.frankie,
		seeded.workers.grace
	].sort();
	expect(await nodeIds(page), 'one node per displayed Worker').toEqual(expected);
	expect(await rowIds(page), 'one Map table row per displayed Worker').toEqual(expected);
	// The Worker-level Grouping stays active beside the contextual filter.
	await expect(page.getByRole('button', { name: /^Group: Team/ })).toBeVisible();
});

test('@ticket-21 only displayed Workers keep their Relationships, and shared assignments add none', async ({
	page,
	request
}) => {
	const seeded = await seed(request);

	await openMapping(page, '/mapping');
	expect(await nodeIds(page)).toHaveLength(7);
	// The three recorded Relationships, and nothing inferred from shared assignments.
	await expect(ties(page)).toHaveCount(3);

	await openMapping(page, filterLink('/mapping', [[seeded.ids.territory, seeded.answers.storeB]]));
	const displayed = await nodeIds(page);
	expect(displayed).toEqual(
		[seeded.workers.alex, seeded.workers.ben, seeded.workers.frankie, seeded.workers.grace].sort()
	);
	// Alex–Grace and Alex–Ben stay; Grace–Dana does not (Dana is outside the population).
	await expect(ties(page)).toHaveCount(2);
	const endpoints = await ties(page).evaluateAll((paths) =>
		paths.flatMap((path) => [
			path.getAttribute('data-tie-source') ?? '',
			path.getAttribute('data-tie-target') ?? ''
		])
	);
	expect(endpoints.every((id) => displayed.includes(id))).toBe(true);

	// Store B with Cashier selects Alex and Ben, who are related: exactly their one
	// recorded Relationship survives, and no shared-Attribute pair is invented.
	await openMapping(
		page,
		filterLink('/mapping', [
			[seeded.ids.territory, seeded.answers.storeB],
			[seeded.ids.position, seeded.answers.cashier]
		])
	);
	await expect(ties(page)).toHaveCount(1);
});

test('@ticket-21 a valid filter survives reload and stale references are validated away', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	const link = filterLink('/mapping', [
		[seeded.ids.territory, seeded.answers.storeB],
		[seeded.ids.position, seeded.answers.stocker],
		[seeded.ids.shift, seeded.answers.nights]
	]);

	await openMapping(page, link);
	const selected = await nodeIds(page);
	expect(selected).toEqual([seeded.workers.alex, seeded.workers.grace].sort());

	await page.reload();
	await waitForMapReady(page);
	expect(await nodeIds(page)).toEqual(selected);
	expect(new URL(page.url()).searchParams.getAll('f')).toEqual([
		seeded.ids.territory + ':' + seeded.answers.storeB,
		seeded.ids.position + ':' + seeded.answers.stocker,
		seeded.ids.shift + ':' + seeded.answers.nights
	]);

	// A stale Attribute, answer or reading from another Worksite selects nothing.
	await openMapping(page, '/mapping?f=territory:gone&f=ghost:value&missing=gone');
	expect(await nodeIds(page)).toHaveLength(7);

	// A stale entry beside a valid one drops only itself.
	await openMapping(
		page,
		'/mapping?f=' +
			seeded.ids.territory +
			':gone&f=' +
			seeded.ids.territory +
			':' +
			seeded.answers.storeB
	);
	expect(await nodeIds(page)).toEqual(
		[seeded.workers.alex, seeded.workers.ben, seeded.workers.frankie, seeded.workers.grace].sort()
	);
});

test('@ticket-07 a retired assignments predicate normalizes away and selects every Worker', async ({
	page,
	request
}) => {
	const seeded = await seed(request);

	// An old zero-assignment link must not select everyone by claiming a filter, nor
	// keep the retired parameter in the address.
	await openMapping(page, '/mapping?assignments=none');
	expect(await nodeIds(page)).toHaveLength(7);
	await expect.poll(() => new URL(page.url()).searchParams.has('assignments')).toBe(false);

	// A retired predicate beside a valid ordinary filter drops only itself and keeps
	// the ordinary selection and any unrelated state.
	await openMapping(
		page,
		'/mapping?assignments=none&f=' + seeded.ids.territory + ':' + seeded.answers.storeB
	);
	expect(await nodeIds(page)).toEqual(
		[seeded.workers.alex, seeded.workers.ben, seeded.workers.frankie, seeded.workers.grace].sort()
	);
	await expect.poll(() => new URL(page.url()).searchParams.has('assignments')).toBe(false);
	expect(new URL(page.url()).searchParams.getAll('f')).toEqual([
		seeded.ids.territory + ':' + seeded.answers.storeB
	]);
});

test('@ticket-07 an active Grouping that becomes invalid after membership changes falls back without a dot duplication', async ({
	page,
	request
}) => {
	const seeded = await seed(request);

	// Store B population holds Alex, Grace, Ben and Frankie; narrowing by Position
	// keeps only the Store B holders who also hold a chosen Job. Removing that narrowing
	// broadens back and a Multi-Select Grouping falls back while keeping one dot each.
	await openMapping(
		page,
		'/mapping?group=' +
			seeded.ids.position +
			'&f=' +
			seeded.ids.territory +
			':' +
			seeded.answers.storeB
	);
	// Position is Multi-Select and cannot place Alex (Cashier + Stocker) in one region.
	await expect(page.getByTestId('map-grouping-fallback')).toBeVisible();
	await expect(page.locator('svg path[stroke-linejoin="round"]')).toHaveCount(0);
	const drawn = await nodeIds(page);
	expect(drawn).toEqual(
		[seeded.workers.alex, seeded.workers.ben, seeded.workers.frankie, seeded.workers.grace].sort()
	);
	// One dot per Worker through the fallback.
	for (const id of drawn) {
		await expect(page.locator(`g[data-node-id="${id}"]`)).toHaveCount(1);
	}
});

test('@ticket-21 a renamed answer keeps membership by id and updates the reading', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	const link = filterLink('/mapping', [[seeded.ids.territory, seeded.answers.storeB]]);
	await openMapping(page, link);
	const selected = await nodeIds(page);
	const chip = page.getByTestId('context-filter-chip').first();
	await expect(chip).toContainText('Store B');

	const renamed = await request.put('/api/attributes', {
		data: [
			{
				id: seeded.ids.territory,
				name: 'Territory',
				kind: 'tag',
				options: [
					{ id: seeded.answers.downtown, value: 'Downtown' },
					{ id: seeded.answers.storeA, value: 'Store A', parentId: seeded.answers.downtown },
					{
						id: seeded.answers.storeB,
						value: 'Store B Renamed',
						parentId: seeded.answers.downtown
					},
					{ id: answerId(seeded.ids.territory, 'Uptown'), value: 'Uptown' },
					{
						id: seeded.answers.northStore,
						value: 'North Store',
						parentId: answerId(seeded.ids.territory, 'Uptown')
					}
				]
			},
			{
				id: seeded.ids.position,
				name: 'Position',
				kind: 'tag',
				options: [
					{ id: seeded.answers.cashier, value: 'Cashier' },
					{ id: seeded.answers.stocker, value: 'Stocker' }
				]
			},
			{
				id: seeded.ids.shift,
				name: 'Shift',
				kind: 'tag',
				options: [
					{ id: seeded.answers.days, value: 'Days' },
					{ id: seeded.answers.nights, value: 'Nights' }
				]
			},
			{
				id: seeded.ids.team,
				name: 'Team',
				kind: 'category',
				options: [
					{ id: seeded.answers.teamA, value: 'Team A' },
					{ id: seeded.answers.teamB, value: 'Team B' }
				]
			}
		]
	});
	expect(renamed.ok(), await renamed.text()).toBeTruthy();

	await page.reload();
	await waitForMapReady(page);
	expect(await nodeIds(page)).toEqual(selected);
	await expect(page.getByTestId('context-filter-chip').first()).toContainText('Store B Renamed');
});

test('@ticket-21 the no-answer reading works for either cardinality', async ({ page, request }) => {
	const seeded = await seed(request);

	// Position is Multi-Select: Frankie and Dana hold none.
	await openMapping(page, '/mapping?missing=' + seeded.ids.position);
	expect(await nodeIds(page)).toEqual([seeded.workers.frankie, seeded.workers.dana].sort());
	await expect(page.getByTestId('context-filter-chip').first()).toContainText('No Position');

	// Team is Single-Select: Dana holds none, so the same predicate works there too.
	await openMapping(page, '/mapping?missing=' + seeded.ids.team);
	expect(await nodeIds(page)).toEqual([seeded.workers.dana]);
	await expect(page.getByTestId('context-filter-chip').first()).toContainText('No Team');

	// Both conditions hold on the same Worker.
	await openMapping(
		page,
		'/mapping?f=' +
			seeded.ids.territory +
			':' +
			seeded.answers.storeB +
			'&missing=' +
			seeded.ids.position
	);
	expect(await nodeIds(page)).toEqual([seeded.workers.frankie]);
});

test('@ticket-21 selection and Isolate stay consistent with the filtered population', async ({
	page,
	request
}) => {
	const seeded = await seed(request);

	// Store B holds Alex, Grace, Ben and Frankie. Isolating Alex draws his neighbourhood
	// inside that population: Alex, Grace and Ben; Frankie is outside his two degrees.
	await openMapping(page, filterLink('/mapping', [[seeded.ids.territory, seeded.answers.storeB]]));
	await selectOnMap(page, seeded.workers.alex);
	await page.getByRole('button', { name: 'Isolate' }).click();
	expect(await nodeIds(page)).toEqual(
		[seeded.workers.alex, seeded.workers.ben, seeded.workers.grace].sort()
	);
	expect(await rowIds(page)).toEqual(
		[seeded.workers.alex, seeded.workers.ben, seeded.workers.grace].sort()
	);

	// Narrowing the population keeps the selected Worker; the drawn set stays inside it.
	await openMapping(page, filterLink('/mapping', [[seeded.ids.territory, seeded.answers.storeA]]));
	await selectOnMap(page, seeded.workers.alex);
	await page.getByRole('button', { name: 'Isolate' }).click();
	expect(await nodeIds(page)).toEqual([seeded.workers.alex]);
	expect(await rowIds(page)).toEqual([seeded.workers.alex]);
});

test('@ticket-21 filtering out the selected Worker closes the record and the drawn set', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openMapping(page, '/mapping');
	await selectOnMap(page, seeded.workers.dana);
	await expect(page.getByRole('region', { name: 'Worker record' })).toContainText('Dian Fossey');

	// Narrow to Store B in the open map: the selection is private memory a reload would
	// drop, so the condition is chosen in place.
	await page.getByRole('button', { name: /^Filter/ }).click();
	const panel = page.locator('#map-filter-panel');
	await expect(panel).toBeVisible();
	await panel
		.getByTestId('map-include-filters')
		.getByRole('button', { name: 'Narrow to Territory', exact: true })
		.click();
	await page.getByRole('menuitemcheckbox', { name: 'Store B', exact: true }).click();
	await page.getByRole('button', { name: /^Filter/ }).click();
	await expect(panel).toBeHidden();

	// Dana holds no Territory value, so the Store B population excludes and deselects her.
	await expect(page.getByRole('region', { name: 'Worker record' })).toHaveCount(0);
	await expect
		.poll(() => nodeIds(page))
		.toEqual(
			[seeded.workers.alex, seeded.workers.ben, seeded.workers.frankie, seeded.workers.grace].sort()
		);
	await expect
		.poll(() => new URL(page.url()).searchParams.getAll('f'))
		.toEqual([seeded.ids.territory + ':' + seeded.answers.storeB]);

	// The chip names the condition and removes it, bringing every Worker back.
	const chip = page.getByTestId('context-filter-chip').first();
	await expect(chip).toContainText('Territory');
	await expect(chip).toContainText('Store B');
	await chip.getByRole('button', { name: 'Stop filtering by Store B' }).click();
	expect(await nodeIds(page)).toHaveLength(7);
});

test('@ticket-09 the Include control writes the condition a filter link writes, and its chip removes it', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	const everyWorker = Object.values(seeded.workers).sort();
	const groupAddress = 'group=' + seeded.ids.team;
	const address = () => new URL(page.url()).searchParams;

	/** Applies one Include choice through the Filter panel's Narrow to controls. */
	async function include(attributeName: string, choice: string) {
		await page.getByRole('button', { name: /^Filter/ }).click();
		const panel = page.locator('#map-filter-panel');
		await expect(panel).toBeVisible();
		await panel
			.getByTestId('map-include-filters')
			.getByRole('button', { name: 'Narrow to ' + attributeName, exact: true })
			.click();
		await page.getByRole('menuitemcheckbox', { name: choice, exact: true }).click();
		// A second press on the trigger closes the panel.
		await page.getByRole('button', { name: /^Filter/ }).click();
		await expect(panel).toBeHidden();
	}

	// The link the control must reproduce: Store B selects its four holders, and the
	// unrelated Grouping stays in the address.
	const storeBPopulation = [
		seeded.workers.alex,
		seeded.workers.ben,
		seeded.workers.frankie,
		seeded.workers.grace
	].sort();
	await openMapping(
		page,
		filterLink('/mapping', [[seeded.ids.territory, seeded.answers.storeB]]) + '&' + groupAddress
	);
	expect(await nodeIds(page), 'the link selects the Store B population').toEqual(storeBPopulation);
	expect(await rowIds(page), 'the Map table lists the same Workers').toEqual(storeBPopulation);

	// The same condition chosen through the Filter panel's Include control, beside view
	// state the filter does not touch.
	await openMapping(page, '/mapping?' + groupAddress);
	await selectOnMap(page, seeded.workers.alex);
	expect(await nodeIds(page)).toEqual(everyWorker);
	await include('Territory', 'Store B');

	await expect
		.poll(() => nodeIds(page), { message: 'the control selects the Store B population' })
		.toEqual(storeBPopulation);
	await expect.poll(() => rowIds(page)).toEqual(storeBPopulation);

	// It wrote exactly the link's entry and kept the unrelated view state: the Grouping
	// and the still-displayed selected Worker.
	await expect
		.poll(() => address().getAll('f'))
		.toEqual([seeded.ids.territory + ':' + seeded.answers.storeB]);
	expect(address().get('group'), 'the Grouping survives').toBe(seeded.ids.team);
	expect(address().has('sel'), 'the selection never enters the address').toBe(false);
	await expect(page.locator(`[data-map-table-row="${seeded.workers.alex}"]`)).toHaveAttribute(
		'aria-selected',
		'true'
	);

	// The chip names the condition and takes it away again.
	const storeBChip = page.getByTestId('context-filter-chip');
	await expect(storeBChip).toHaveCount(1);
	await expect(storeBChip).toContainText('Territory');
	await expect(storeBChip).toContainText('Store B');
	await storeBChip.getByRole('button', { name: 'Stop filtering by Store B' }).click();
	await expect.poll(() => nodeIds(page)).toEqual(everyWorker);
	await expect.poll(() => address().has('f')).toBe(false);
	expect(address().get('group'), 'removing the chip keeps the Grouping').toBe(seeded.ids.team);

	// The no-answer reading is a condition too: "No Position" keeps the Workers holding no
	// Position value, exactly like the equivalent missing link.
	const noPositionPopulation = [seeded.workers.dana, seeded.workers.frankie].sort();
	await openMapping(page, '/mapping?missing=' + seeded.ids.position + '&' + groupAddress);
	expect(await nodeIds(page), 'the missing link selects the no-Position population').toEqual(
		noPositionPopulation
	);

	await openMapping(page, '/mapping?' + groupAddress);
	await include('Position', 'No Position');
	await expect.poll(() => nodeIds(page)).toEqual(noPositionPopulation);
	await expect.poll(() => address().getAll('missing')).toEqual([seeded.ids.position]);
	expect(address().get('group'), 'the Grouping survives the no-answer condition').toBe(
		seeded.ids.team
	);
	const missingChip = page.getByTestId('context-filter-chip');
	await expect(missingChip).toHaveCount(1);
	await missingChip.getByRole('button', { name: 'Stop filtering by No Position' }).click();
	await expect.poll(() => nodeIds(page)).toEqual(everyWorker);
	await expect.poll(() => address().has('missing')).toBe(false);
});

test('@ticket-22 workplace questions are offered as a contextual Grouping with their availability', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openMapping(page, '/mapping');

	await page.getByRole('button', { name: /^Group/ }).click();
	await page.locator('#map-group-by').click();
	// Territory is available because Alex's two stores share the unexpanded Central
	// region; Position and Shift cannot place Alex in one region, so they are not offered.
	await expect(page.getByRole('option')).toHaveText(['None', 'Territory', 'Team']);
	await page.keyboard.press('Escape');

	// A restored workplace Grouping that cannot partition falls back to Free and keeps
	// the choice, rather than silently normalizing the address away.
	await openMapping(page, '/mapping?group=' + seeded.ids.position);
	await expect(page.getByRole('button', { name: /^Group: Position/ })).toBeVisible();
	await expect(page.getByTestId('map-grouping-fallback')).toBeVisible();
	await expect(page.locator('svg path[stroke-linejoin="round"]')).toHaveCount(0);
});
