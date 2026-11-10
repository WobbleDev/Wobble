import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test, testId } from './fixtures.ts';
import { waitForMapReady } from './map.ts';
import { openMapping } from './pages.ts';
import { answerId } from './answer-wire.ts';

/**
 * Ticket 07: Mapping expands useful hierarchy branches, keeps the direct-parent
 * remainders, and restores its chosen detail without breaking one-dot membership.
 *
 * Fixture: Location is a Multi-Select hierarchy (Central with Store A and Store B),
 * Department is a Single-Select hierarchy (Operations with Front of House and Back
 * of House, and Gray holds Operations itself). Alex and Blair each hold Store A /
 * Cashier and Store B / Stocker; Casey holds Central; Drew Store A; Erin Central
 * and Store A; Frankie Store B with no Job; Gray holds nothing; Hana Store A with
 * a real answer literally called Unknown Job.
 */

type Dept = 'Front' | 'Back' | 'All';

type Person = {
	key: string;
	name: string;
	dept: Dept;
	loc: string[];
	job: string[];
	shift: string[];
};

const people: Person[] = [
	{
		key: 'alex',
		name: 'Alex',
		dept: 'Front',
		loc: ['Store A', 'Store B'],
		job: ['Cashier', 'Stocker'],
		shift: ['Days', 'Nights']
	},
	{
		key: 'blair',
		name: 'Blair',
		dept: 'Front',
		loc: ['Store A', 'Store B'],
		job: ['Cashier', 'Stocker'],
		shift: []
	},
	{ key: 'casey', name: 'Casey', dept: 'Front', loc: ['Central'], job: [], shift: [] },
	{ key: 'drew', name: 'Drew', dept: 'Front', loc: ['Store A'], job: [], shift: [] },
	{ key: 'erin', name: 'Erin', dept: 'Back', loc: ['Central', 'Store A'], job: [], shift: [] },
	{ key: 'frankie', name: 'Frankie', dept: 'Back', loc: ['Store B'], job: [], shift: [] },
	{ key: 'gray', name: 'Gray', dept: 'All', loc: [], job: [], shift: [] },
	{ key: 'hana', name: 'Hana', dept: 'Back', loc: ['Store A'], job: ['Unknown Job'], shift: [] }
];

type WireOption = { id: string; value: string; parentId?: string };
type WireAttribute = {
	id: string;
	name: string;
	kind: 'category' | 'tag';
	options: WireOption[];
};

type Seeded = {
	ids: { loc: string; job: string; shift: string; dept: string };
	answers: Record<string, string>;
	workers: Record<string, string>;
	definitions: WireAttribute[];
};

async function seed(
	request: APIRequestContext,
	keys = people.map(({ key }) => key)
): Promise<Seeded> {
	const ids = {
		loc: 'loc-' + testId(),
		job: 'job-' + testId(),
		shift: 'shift-' + testId(),
		dept: 'dept-' + testId()
	};
	const answer = (attribute: string, text: string) => answerId(attribute, text);
	const answers = {
		central: answer(ids.loc, 'Central'),
		storeA: answer(ids.loc, 'Store A'),
		storeB: answer(ids.loc, 'Store B'),
		cashier: answer(ids.job, 'Cashier'),
		stocker: answer(ids.job, 'Stocker'),
		unknownJob: answer(ids.job, 'Unknown Job'),
		days: answer(ids.shift, 'Days'),
		nights: answer(ids.shift, 'Nights'),
		operations: answer(ids.dept, 'Operations'),
		front: answer(ids.dept, 'Front of House'),
		back: answer(ids.dept, 'Back of House')
	};

	const definitions: WireAttribute[] = [
		{
			id: ids.loc,
			name: 'Location',
			kind: 'tag',
			options: [
				{ id: answers.central, value: 'Central' },
				{ id: answers.storeA, value: 'Store A', parentId: answers.central },
				{ id: answers.storeB, value: 'Store B', parentId: answers.central }
			]
		},
		{
			id: ids.job,
			name: 'Job',
			kind: 'tag',
			options: [
				{ id: answers.cashier, value: 'Cashier' },
				{ id: answers.stocker, value: 'Stocker' },
				{ id: answers.unknownJob, value: 'Unknown Job' }
			]
		},
		{
			id: ids.shift,
			name: 'Shift',
			kind: 'tag',
			options: [
				{ id: answers.days, value: 'Days' },
				{ id: answers.nights, value: 'Nights' }
			]
		},
		{
			id: ids.dept,
			name: 'Department',
			kind: 'category',
			options: [
				{ id: answers.operations, value: 'Operations' },
				{ id: answers.front, value: 'Front of House', parentId: answers.operations },
				{ id: answers.back, value: 'Back of House', parentId: answers.operations }
			]
		}
	];
	await putAttributes(request, definitions);

	const heldLoc = (text: string) =>
		text === 'Central' ? answers.central : text === 'Store A' ? answers.storeA : answers.storeB;
	const heldJob = (text: string) =>
		text === 'Cashier'
			? answers.cashier
			: text === 'Stocker'
				? answers.stocker
				: answers.unknownJob;
	const heldShift = (text: string) => (text === 'Days' ? answers.days : answers.nights);

	const workers: Record<string, string> = {};
	for (const person of people.filter(({ key }) => keys.includes(key))) {
		const created = await request.post('/api/workers', {
			data: {
				name: person.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: {
					[ids.dept]:
						person.dept === 'Front'
							? answers.front
							: person.dept === 'Back'
								? answers.back
								: answers.operations,
					[ids.loc]: person.loc.map(heldLoc),
					[ids.job]: person.job.map(heldJob),
					[ids.shift]: person.shift.map(heldShift)
				},
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		workers[person.key] = ((await created.json()) as { worker: { id: string } }).worker.id;
	}

	if (workers.alex && workers.blair) await relate(request, workers.alex, workers.blair);
	if (workers.casey && workers.drew) await relate(request, workers.casey, workers.drew);

	return { ids, answers, workers, definitions };
}

async function putAttributes(
	request: APIRequestContext,
	definitions: WireAttribute[]
): Promise<void> {
	const configured = await request.put('/api/attributes', { data: definitions });
	expect(configured.ok(), await configured.text()).toBeTruthy();
}

async function relate(request: APIRequestContext, first: string, second: string): Promise<void> {
	const related = await request.patch('/api/workers/' + first, {
		data: { field: 'relationships', action: 'add', value: { id: second } }
	});
	expect(related.ok(), await related.text()).toBeTruthy();
}

const regionOutlines = 'svg path[stroke-linejoin="round"]';

const nodeIds = (page: Page) =>
	page
		.locator('svg g[role="button"][data-node-id]')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-id') ?? '').sort());

const rowIds = (page: Page) =>
	page
		.locator('[data-map-table-row]')
		.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-map-table-row') ?? '').sort());

const rowText = async (page: Page, id: string): Promise<string> =>
	((await page.locator('[data-map-table-row="' + id + '"]').textContent()) ?? '').replace(
		/\s+/g,
		' '
	);

async function openGroupMenu(page: Page): Promise<void> {
	const trigger = page.getByRole('button', { name: /^Group/ });
	if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
	await expect(page.locator('#map-group-by')).toBeVisible();
}

test.use({ reducedMotion: 'reduce' });

test('@ticket-07 an attempted expansion that would split displayed Workers is refused and changes nothing', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openMapping(page, '?group=' + seeded.ids.loc);
	await expect(page.locator('[data-region-label="' + seeded.answers.central + '"]')).toBeVisible();
	const before = {
		nodes: await nodeIds(page),
		rows: await rowIds(page),
		ties: await page.locator('svg path[data-tie]').count()
	};

	await openGroupMenu(page);
	await page
		.locator(
			'[data-testid="map-expansion-primary"] [data-expand-branch="' + seeded.answers.central + '"]'
		)
		.click();

	// Erin holds Central and Store A; Alex and Blair span Store A and Store B, so the
	// candidate detail cannot put every displayed Worker in one region.
	await expect(page.getByTestId('map-expansion-refusal')).toBeVisible();
	await expect(page.getByTestId('map-expansion-refusal')).toContainText('Cannot expand');
	await expect(page.getByTestId('map-expansion-refusal')).toContainText('Erin');

	// The coarser view, its address and its one-node/one-row membership are untouched.
	await expect(page.locator('[data-region-label="' + seeded.answers.central + '"]')).toBeVisible();
	expect(new URL(page.url()).searchParams.has('x')).toBe(false);
	expect(await nodeIds(page)).toEqual(before.nodes);
	expect(await rowIds(page)).toEqual(before.rows);
	expect(await page.locator('svg path[data-tie]').count()).toBe(before.ties);
});

test('@ticket-07 expanding an occupied branch yields its children and exact remainder, and restores by identity', async ({
	page,
	request
}) => {
	const seeded = await seed(request, ['casey', 'drew', 'frankie']);
	const remainder = '#self:' + seeded.ids.loc + ':' + seeded.answers.central;
	await openMapping(page, '?group=' + seeded.ids.loc);
	await openGroupMenu(page);
	await page
		.locator(
			'[data-testid="map-expansion-primary"] [data-expand-branch="' + seeded.answers.central + '"]'
		)
		.click();

	// Casey holds Central directly, so she is the further-detail-unknown remainder;
	// Drew and Frankie stay in the child regions their answers name.
	await expect(page.locator('[data-region-label="' + remainder + '"]')).toBeVisible();
	await expect
		.poll(() => new URL(page.url()).searchParams.getAll('x'))
		.toEqual([seeded.ids.loc + ':' + seeded.answers.central]);
	expect(await nodeIds(page)).toHaveLength(3);
	expect(await rowIds(page)).toHaveLength(3);
	expect(await rowText(page, seeded.workers.casey)).toContain('this group only');
	expect(await rowText(page, seeded.workers.drew)).toContain('Store A');
	expect(await rowText(page, seeded.workers.frankie)).toContain('Store B');
	// Expansion is a reading, not new Relationships.
	expect(await page.locator('svg path[data-tie]').count()).toBe(1);

	// The address restores the same detail and the same membership.
	await page.reload();
	await waitForMapReady(page);
	await expect(page.locator('[data-region-label="' + remainder + '"]')).toBeVisible();
	expect(await nodeIds(page)).toHaveLength(3);
	expect(await rowIds(page)).toHaveLength(3);

	// Collapsing writes the coarser detail back and brings the branch region back.
	await openGroupMenu(page);
	await page
		.locator(
			'[data-testid="map-expansion-primary"] [data-expand-branch="' + seeded.answers.central + '"]'
		)
		.click();
	await expect.poll(() => new URL(page.url()).searchParams.getAll('x')).toEqual([]);
	await expect(page.locator('[data-region-label="' + seeded.answers.central + '"]')).toBeVisible();
	await expect(page.locator('[data-region-label="' + remainder + '"]')).toHaveCount(0);
});

test('@ticket-07 an active detail that no longer partitions falls back to Free with its explanation, filters and x kept', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openMapping(
		page,
		'?group=' +
			seeded.ids.loc +
			'&x=' +
			seeded.ids.loc +
			':' +
			seeded.answers.central +
			'&no=Hostile'
	);

	// The restored detail cannot place every displayed Worker in one region, so the
	// explained Free fallback keeps the choice, its detail and the valid filter.
	await expect(page.getByTestId('map-grouping-fallback')).toBeVisible();
	await expect(page.getByTestId('map-grouping-fallback')).toContainText('Free layout');
	await expect(page.locator(regionOutlines)).toHaveCount(0);
	await expect
		.poll(() => new URL(page.url()).searchParams.getAll('x'))
		.toEqual([seeded.ids.loc + ':' + seeded.answers.central]);
	expect(new URL(page.url()).searchParams.get('group')).toBe(seeded.ids.loc);
	expect(new URL(page.url()).searchParams.getAll('no')).toEqual(['Hostile']);
	expect(await nodeIds(page)).toHaveLength(8);
	expect(await rowIds(page)).toHaveLength(8);

	// Collapsing the offending branch recovers the grouping without clearing the filter.
	await openGroupMenu(page);
	await page
		.locator(
			'[data-testid="map-expansion-primary"] [data-expand-branch="' + seeded.answers.central + '"]'
		)
		.click();
	await expect(page.getByTestId('map-grouping-fallback')).toHaveCount(0);
	await expect.poll(() => page.locator(regionOutlines).count()).toBeGreaterThan(0);
	expect(new URL(page.url()).searchParams.getAll('x')).toEqual([]);
	expect(new URL(page.url()).searchParams.getAll('no')).toEqual(['Hostile']);
});

test('@ticket-07 primary and secondary branches expand independently and the table carries each remainder', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openMapping(
		page,
		'?group=' +
			seeded.ids.loc +
			'&sub=' +
			seeded.ids.dept +
			'&xs=' +
			seeded.ids.dept +
			':' +
			seeded.answers.operations
	);

	// The primary reading stays at its roots: Central is one region, not a remainder.
	await expect(page.locator('[data-region-label="' + seeded.answers.central + '"]')).toBeVisible();
	// The secondary detail replaces Operations with its children and its occupied remainder.
	// A secondary region repeats inside every primary group that holds it.
	const secondaryRemainder = '#self:' + seeded.ids.dept + ':' + seeded.answers.operations;
	await expect(
		page.locator('[data-sub-hull*="' + seeded.answers.front + '"]').first()
	).toBeVisible();
	await expect(
		page.locator('[data-sub-hull*="' + seeded.answers.back + '"]').first()
	).toBeVisible();
	await expect(page.locator('[data-sub-hull*="' + secondaryRemainder + '"]')).toHaveCount(1);
	expect(await rowText(page, seeded.workers.gray)).toContain('Operations');
	expect(await rowText(page, seeded.workers.gray)).toContain('this group only');
	expect(await nodeIds(page)).toHaveLength(8);
	expect(await rowIds(page)).toHaveLength(8);
	// Only the secondary branch is open.
	expect(new URL(page.url()).searchParams.getAll('x')).toEqual([]);
	expect(new URL(page.url()).searchParams.getAll('xs')).toEqual([
		seeded.ids.dept + ':' + seeded.answers.operations
	]);
});

test('@ticket-07 renaming an answer keeps branch identity, membership and the configured order, and adds no Relationship', async ({
	page,
	request
}) => {
	const seeded = await seed(request, ['casey', 'drew', 'frankie']);
	const remainder = '#self:' + seeded.ids.loc + ':' + seeded.answers.central;
	const path = '?group=' + seeded.ids.loc + '&x=' + seeded.ids.loc + ':' + seeded.answers.central;
	await openMapping(page, path);
	await expect(page.locator('[data-region-label="' + remainder + '"]')).toBeVisible();
	const before = { nodes: await nodeIds(page), rows: await rowIds(page) };
	expect(await page.locator('svg path[data-tie]').count()).toBe(1);

	// Rename Store A with its id unchanged: same branch, new label.
	const renamed = seeded.definitions.map((definition) =>
		definition.id !== seeded.ids.loc
			? definition
			: {
					...definition,
					options: definition.options.map((option) =>
						option.id === seeded.answers.storeA ? { ...option, value: 'Zeta' } : option
					)
				}
	);
	await putAttributes(request, renamed);

	await page.reload();
	await waitForMapReady(page);
	await expect(page.locator('svg text').filter({ hasText: 'Zeta' })).toBeVisible();
	await expect(page.locator('[data-region-label="' + seeded.answers.storeA + '"]')).toBeVisible();
	await expect(page.locator('[data-region-label="' + remainder + '"]')).toBeVisible();
	expect(await nodeIds(page)).toEqual(before.nodes);
	expect(await rowIds(page)).toEqual(before.rows);
	expect(await rowText(page, seeded.workers.drew)).toContain('Zeta');
	expect(await page.locator('svg path[data-tie]').count()).toBe(1);
	expect(new URL(page.url()).searchParams.getAll('x')).toEqual([
		seeded.ids.loc + ':' + seeded.answers.central
	]);
});
