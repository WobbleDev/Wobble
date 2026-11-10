import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test, testId } from './fixtures.ts';
import { waitForMapReady } from './map.ts';
import { openMapping } from './pages.ts';
import { answerId } from './answer-wire.ts';

/**
 * Ticket 07: Mapping offers a contextual Grouping only when every displayed Worker
 * can occupy one region, explains why an unavailable choice cannot, narrows towards
 * a choice that will work, and falls back to Free without losing the view.
 *
 * Fixture: Location is a Multi-Select hierarchy (Central with Store A and Store B),
 * Job and Shift are flat Multi-Select questions, Department is a Single-Select
 * question. Alex and Blair each hold Store A / Cashier and Store B / Stocker; Casey
 * holds Central; Drew Store A; Erin Central and Store A; Frankie Store B with no Job;
 * Gray holds nothing; Hana Store A / a real answer literally called Unknown Job.
 *
 * Several held values never duplicate a dot: a Multi-Select Attribute groups whenever
 * its selections resolve to one displayed region per Worker, and stays unavailable
 * with the existing explanation otherwise.
 */

type Person = {
	key: string;
	name: string;
	dept: 'Front' | 'Back';
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
	{ key: 'gray', name: 'Gray', dept: 'Back', loc: [], job: [], shift: [] },
	{ key: 'hana', name: 'Hana', dept: 'Back', loc: ['Store A'], job: ['Unknown Job'], shift: [] }
];

type Seeded = {
	ids: { loc: string; job: string; shift: string; dept: string };
	answers: Record<string, string>;
	workers: Record<string, string>;
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
		front: answer(ids.dept, 'Front of House'),
		back: answer(ids.dept, 'Back of House')
	};

	const configured = await request.put('/api/attributes', {
		data: [
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
					{ id: answers.front, value: 'Front of House' },
					{ id: answers.back, value: 'Back of House' }
				]
			}
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const held = (text: string) =>
		text === 'Central'
			? answers.central
			: text === 'Store A'
				? answers.storeA
				: text === 'Store B'
					? answers.storeB
					: text === 'Cashier'
						? answers.cashier
						: text === 'Stocker'
							? answers.stocker
							: text === 'Unknown Job'
								? answers.unknownJob
								: text === 'Days'
									? answers.days
									: answers.nights;

	const workers: Record<string, string> = {};
	for (const person of people.filter(({ key }) => keys.includes(key))) {
		const created = await request.post('/api/workers', {
			data: {
				name: person.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: {
					[ids.dept]: person.dept === 'Front' ? answers.front : answers.back,
					[ids.loc]: person.loc.map(held),
					[ids.job]: person.job.map(held),
					[ids.shift]: person.shift.map(held)
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

	if (workers.alex && workers.blair) {
		await relate(request, workers.alex, workers.blair);
	}
	if (workers.casey && workers.drew) {
		await relate(request, workers.casey, workers.drew);
	}

	return { ids, answers, workers };
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

async function openGroupMenu(page: Page): Promise<void> {
	const trigger = page.getByRole('button', { name: /^Group(:|$)/ });
	if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
	await expect(page.locator('#map-group-by')).toBeVisible();
}

test.use({ reducedMotion: 'reduce' });

test('@ticket-07 an ambiguous Grouping stays visible, explains itself, and naming a parent makes it group', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openMapping(page, '?group=' + seeded.ids.job);

	// Job cannot place Alex (Cashier + Stocker) in one region, so the choice is kept
	// and named, the map is Free with an explanation, and no dot is duplicated.
	await expect(page.getByRole('button', { name: /^Group/ })).toContainText('Job');
	await expect(page.getByTestId('map-grouping-fallback')).toBeVisible();
	await expect(page.getByTestId('map-grouping-fallback')).toContainText('Free layout');
	await expect(page.locator(regionOutlines)).toHaveCount(0);
	expect(await nodeIds(page)).toHaveLength(8);
	expect(await rowIds(page)).toHaveLength(8);

	// Opening the choice shows the reason and the checked narrowing guidance.
	await openGroupMenu(page);
	await expect(page.getByTestId('map-grouping-status')).toContainText('one region');
	await expect(page.getByTestId('map-grouping-status')).toContainText('Alex');
	await expect(page.getByTestId('map-grouping-status')).toContainText('Cashier');
	await expect(page.getByTestId('map-grouping-status')).toContainText('Stocker');
	await expect(page.getByTestId('map-grouping-suggestion').first()).toBeVisible();

	// The unavailable attribute is still a visible option, marked rather than hidden.
	await page.locator('#map-group-by').click();
	await expect(page.getByRole('option', { name: 'Job (unavailable)' })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');

	// Location is a Multi-Select whose two held stores share the unexpanded Central
	// region, so it groups while Job stays unavailable: a Multi-Select may group
	// whenever its selections resolve to one displayed region per Worker.
	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option', { name: 'Location', exact: true }).click();
	await expect(page.getByTestId('map-grouping-fallback')).toHaveCount(0);
	await expect(page.locator('[data-region-label="' + seeded.answers.central + '"]')).toBeVisible();
	// One region per Worker still means exactly one dot per Worker.
	expect(await nodeIds(page)).toHaveLength(8);
	expect(await rowIds(page)).toHaveLength(8);
});

test('@ticket-07 an unavailable choice is hidden, and an invalid restored view falls back until explicitly cleared', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openMapping(page);

	// QF-010: a choice that cannot partition the displayed Workers is not offered.
	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await expect(page.getByRole('option', { name: /^Job/ })).toHaveCount(0);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');

	// A restored address naming it still falls back and keeps the choice.
	await openMapping(page, '?group=' + seeded.ids.job);
	await expect(page.getByTestId('map-grouping-fallback')).toBeVisible();
	await expect(page.locator(regionOutlines)).toHaveCount(0);

	// A reload keeps the choice and its explanation; the address is never rewritten to None.
	await page.reload();
	await waitForMapReady(page);
	await expect(page.getByTestId('map-grouping-fallback')).toBeVisible();
	expect(new URL(page.url()).searchParams.get('group')).toBe(seeded.ids.job);
	expect(new URL(page.url()).searchParams.get('layout')).toBeNull();

	// The explicit clear is the only thing that drops the choice.
	await page
		.getByTestId('map-grouping-fallback')
		.getByRole('button', { name: 'Clear grouping' })
		.click();
	await expect(page).not.toHaveURL(/group=/);
	await expect(page.getByTestId('map-grouping-fallback')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Group$/ })).toBeVisible();
});

test('@ticket-07 narrowing that makes the active Grouping invalid falls back and keeps valid filters', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	// Narrowing to Back drops Alex, Blair, Casey and Drew; the remaining Workers each
	// hold at most one Job, so the still-active Job choice groups.
	await openMapping(
		page,
		'?group=' + seeded.ids.job + '&f=' + seeded.ids.dept + ':' + seeded.answers.back
	);
	await expect(page.getByTestId('map-grouping-fallback')).toHaveCount(0);
	await expect.poll(() => page.locator(regionOutlines).count()).toBeGreaterThan(0);
	expect(await nodeIds(page)).toEqual(
		[seeded.workers.erin, seeded.workers.frankie, seeded.workers.gray, seeded.workers.hana].sort()
	);
	expect(await rowIds(page)).toEqual(
		[seeded.workers.erin, seeded.workers.frankie, seeded.workers.gray, seeded.workers.hana].sort()
	);

	// Removing the narrowing condition broadens the population; Job can no longer
	// partition it (Alex and Blair each hold Cashier and Stocker), so the active choice
	// falls back while the view keeps the choice and drops only the removed filter.
	await page
		.getByTestId('context-filter-chip')
		.getByRole('button', { name: 'Stop filtering by Back of House' })
		.click();

	await expect(page.getByTestId('map-grouping-fallback')).toBeVisible();
	await expect(page.locator(regionOutlines)).toHaveCount(0);
	await expect(page).not.toHaveURL(/[?&]f=/);
	expect(new URL(page.url()).searchParams.get('group')).toBe(seeded.ids.job);
	expect(new URL(page.url()).searchParams.has('layout')).toBe(false);
	expect(await nodeIds(page)).toHaveLength(8);
	expect(await rowIds(page)).toHaveLength(8);
});
