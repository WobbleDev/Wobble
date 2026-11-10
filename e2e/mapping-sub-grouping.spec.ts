import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test, testId } from './fixtures.ts';
import { waitForMapReady } from './map.ts';
import { answerId, wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

/** Opens the Group popover unless it is already open. */
async function openGroupMenu(page: Page) {
	const trigger = page.getByRole('button', { name: /^Group(:|$)/ });
	if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
	await expect(page.locator('#map-group-by')).toBeVisible();
}

test.use({ reducedMotion: 'reduce' });

async function seedWorksite(request: APIRequestContext) {
	const deptId = testId();
	const roleId = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: deptId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: roleId, name: 'Role', kind: 'category', options: ['Server', 'Cook'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	for (const worker of [
		{ name: 'Ada', dept: 'Front of House', role: 'Server' },
		{ name: 'Grace', dept: 'Front of House', role: 'Cook' },
		{ name: 'Lin', dept: 'Back of House', role: 'Server' },
		{ name: 'Noor', dept: 'Back of House', role: '' }
	]) {
		const created = await request.post('/api/workers', {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({ [deptId]: worker.dept, [roleId]: worker.role }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status()).toBe(201);
	}

	return { deptId, roleId };
}

test('sub-grouping is optional, shareable and clearable', async ({ page, request }) => {
	const { deptId, roleId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapReady(page);

	await expect(
		page.locator(`[data-region-label="${answerId(deptId, 'Front of House')}"]`)
	).toBeVisible();

	// The control offers None plus the Categories the primary grouping is not using.
	await openGroupMenu(page);
	const subGroup = page.getByLabel('Sub-group by');
	await expect(subGroup).toHaveText('None');
	await subGroup.click();

	const options = page.getByRole('option');
	await expect(options).toHaveText(['None', 'Role']);
	await page.getByRole('option', { name: 'Role' }).click();

	await expect(page).toHaveURL(new RegExp(`sub=${roleId}`));

	await page.reload();
	await waitForMapReady(page);
	await openGroupMenu(page);
	await expect(page.getByLabel('Sub-group by')).toHaveText('Role');

	await page.getByLabel('Sub-group by').click();
	await page.getByRole('option', { name: 'None' }).click();

	await expect(page).not.toHaveURL(/sub=/);
});

test('sub-group labels clear the chrome and the map fills the free canvas', async ({
	page,
	request
}) => {
	const { deptId, roleId } = await seedWorksite(request);
	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto(`/mapping?group=${deptId}&sub=${roleId}`);
	await waitForMapReady(page);
	await expect.poll(() => page.locator('text[data-region-label]').count()).toBeGreaterThan(0);
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const surface = document.querySelector('[role="application"]')?.getBoundingClientRect();
					const strip = document
						.querySelector('[data-testid="mapping-control-strip"]')
						?.getBoundingClientRect();
					const bar = document
						.querySelector('[data-testid="mapping-bottom-bar"]')
						?.getBoundingClientRect();
					const layer = document.querySelector('g[data-testid="relationship-map-layer"]');
					if (!surface || !strip || !bar || !(layer instanceof SVGGraphicsElement))
						return undefined;
					const map = layer.getBoundingClientRect();
					const labels = [...document.querySelectorAll('text[data-region-label]')].map((label) =>
						label.getBoundingClientRect()
					);
					const freeHeight = bar.top - strip.bottom;
					return {
						labelsClear: labels.every(
							(label) =>
								label.top >= strip.bottom &&
								// The key floats over the bottom-left corner only: a label clears it
								// by not touching its box, wherever else on the canvas it sits.
								(label.bottom <= bar.top || label.right <= bar.left || label.left >= bar.right)
						),
						// Fitting the groups to the canvas leaves ~80% on a narrow window.
						fills: map.width >= surface.width * 0.75 || map.height >= freeHeight * 0.75,
						count: labels.length
					};
				}),
			{ timeout: 10_000 }
		)
		.toMatchObject({ labelsClear: true, fills: true });
});

test('sub-grouping keeps a Category out of use as the primary grouping', async ({
	page,
	request
}) => {
	const { deptId, roleId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${roleId}&sub=${deptId}`);
	await waitForMapReady(page);

	await openGroupMenu(page);
	await expect(page.getByLabel('Sub-group by')).toHaveText('Department');
	await openGroupMenu(page);
	await page.locator('#map-group-by').click();
	await page.getByRole('option', { name: 'Department' }).click();

	// The sub-grouping cannot survive naming the same attribute as the primary grouping.
	await openGroupMenu(page);
	await expect(page.getByLabel('Sub-group by')).toHaveText('None');
	await expect(page).not.toHaveURL(/sub=/);
});

test('worker tooltip follows the active theme', async ({ page, request }) => {
	const { deptId } = await seedWorksite(request);

	// The fresh regular-suite database uses system theme; emulate it per page.
	await page.emulateMedia({ colorScheme: 'light' });

	await page.goto(`/mapping?group=${deptId}`);
	await waitForMapReady(page);

	const tooltip = page.locator('.lc-tooltip-container');
	const worker = page.getByRole('button', { name: 'Ada, Unassessed, 0 relationships' });
	await worker.hover();
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toContainText('Assessment');

	const matchesThemeTokens = () =>
		tooltip.evaluate((element) => {
			const reference = document.createElement('div');
			reference.style.backgroundColor = 'var(--popover)';
			reference.style.color = 'var(--popover-foreground)';
			document.body.append(reference);

			const actual = getComputedStyle(element);
			const expected = getComputedStyle(reference);
			const matches =
				actual.backgroundColor === expected.backgroundColor && actual.color === expected.color;
			reference.remove();
			return matches;
		});

	await expect.poll(matchesThemeTokens).toBe(true);

	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(page.locator('html')).toHaveClass(/\bdark\b/);
	await worker.hover();
	await expect(tooltip).toBeVisible();
	await expect.poll(matchesThemeTokens).toBe(true);
});

test('each sub-group is drawn inside its group, and an absent answer is left unoutlined', async ({
	page,
	request
}) => {
	const { deptId, roleId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${deptId}&sub=${roleId}`);
	await waitForMapReady(page);

	const groupWithRegions = 'g:has(> path[stroke-linejoin="round"])';

	// Front of House splits into Server and Cook; Back of House into Server and an absent answer,
	// so three of the four sub-groups are outlined, each inside its group's outline.
	await expect(page.locator(`${groupWithRegions} > g:has(> path)`)).toHaveCount(3);
	await expect(page.locator(`${groupWithRegions} > g > text:text-matches("^Cook")`)).toHaveCount(1);

	// A bucket for workers with no answer is named after the question and never outlined.
	await expect(page.locator('svg text:text-matches("^No Role")')).toHaveCount(1);
	await expect(page.locator('g:has(> text:text-matches("^No Role")) > path')).toHaveCount(0);

	// A sub-group is a deeper filled hull, not an outline.
	const subHulls = page.locator(`${groupWithRegions} > g > path`);
	await expect(subHulls).toHaveCount(3);
	for (const hull of await subHulls.all()) {
		await expect(hull).toHaveClass(/fill-chip/);
		await expect(hull).not.toHaveAttribute('stroke-width', /.+/);
	}
});

test('group and sub-group labels start clear and keep their attachments after zooming', async ({
	page,
	request
}) => {
	const { deptId, roleId } = await seedWorksite(request);
	await page.goto(`/mapping?group=${deptId}&sub=${roleId}`);
	const labels = page.locator('[data-region-label]');
	await expect(labels).toHaveCount(6);
	const separated = () =>
		labels.evaluateAll((elements) => {
			const boxes = elements.map((el) => el.getBoundingClientRect());
			return boxes.every((a, i) =>
				boxes
					.slice(i + 1)
					.every(
						(b) => !(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
					)
			);
		});
	await expect.poll(separated).toBe(true);
	const attachments = () =>
		labels.evaluateAll((elements) =>
			elements.map((el) => [
				el.getAttribute('data-region-label'),
				el.getAttribute('x'),
				el.getAttribute('y'),
				el.getAttribute('transform')
			])
		);
	const before = await attachments();
	await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
	expect(await attachments()).toEqual(before);
	await page.screenshot({ path: test.info().outputPath('labels.png') });
});

test('truncated map labels show the whole name on hover and keyboard focus', async ({
	page,
	request
}) => {
	const name = 'An exceptionally long Department name '.repeat(8).trim();
	const id = testId();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([{ id, name: 'Department', kind: 'category', options: [name] }])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const created = await request.post('/api/workers', {
		data: {
			name: 'Ada',
			email: '',
			phone: '',
			assessment: 'Unassessed',
			attributes: wireWorkerAttributes({ [id]: name }),
			agitations: [],
			languages: [],
			relationships: [],
			notes: []
		}
	});
	expect(created.ok(), await created.text()).toBeTruthy();
	await page.goto(`/mapping?group=${id}`);
	const label = page.locator('[data-region-label]');
	await expect(label).toContainText('…');
	await waitForMapReady(page);
	await label.hover();
	await expect(page.getByRole('tooltip')).toContainText(name.trim());
	await page.mouse.move(0, 0);
	await label.focus();
	await expect(page.getByRole('tooltip')).toContainText(name.trim());
	await expect(label).toHaveAccessibleName(name.trim());
	await page.screenshot({ path: test.info().outputPath('truncated-label.png') });
});

/**
 * Ticket 07 fixture: Location is a Multi-Select hierarchy (Central with Store A and
 * Store B), Job and Shift are flat Multi-Select questions, and Department is a
 * Single-Select question. Alex and Blair hold Store A / Cashier / Days and Store B /
 * Stocker / Nights; Casey holds Central; Frankie Store B with no Job; Gray holds
 * nothing; Hana Store A / a real answer literally called Unknown Job; Dana holds
 * Store A / Cashier with Days and Nights, deduplicated to one pair.
 */
type PairedPerson = {
	key: string;
	name: string;
	dept: 'Front' | 'Back';
	loc: string[];
	job: string[];
	shift: string[];
};

const pairedPeople: PairedPerson[] = [
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
		shift: ['Days', 'Nights']
	},
	{ key: 'casey', name: 'Casey', dept: 'Front', loc: ['Central'], job: [], shift: [] },
	{ key: 'frankie', name: 'Frankie', dept: 'Back', loc: ['Store B'], job: [], shift: [] },
	{ key: 'gray', name: 'Gray', dept: 'Back', loc: [], job: [], shift: [] },
	{ key: 'hana', name: 'Hana', dept: 'Back', loc: ['Store A'], job: ['Unknown Job'], shift: [] },
	{
		key: 'dana',
		name: 'Dana',
		dept: 'Front',
		loc: ['Store A'],
		job: ['Cashier'],
		shift: ['Days', 'Nights']
	}
];

async function seedPaired(request: APIRequestContext, keys = pairedPeople.map(({ key }) => key)) {
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
	for (const person of pairedPeople.filter(({ key }) => keys.includes(key))) {
		const created = await request.post('/api/workers', {
			data: {
				name: person.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: {
					[ids.dept]: person.dept === 'Front' ? answers.front : answers.back,
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

	if (workers.alex && workers.blair) {
		await request.patch('/api/workers/' + workers.alex, {
			data: { field: 'relationships', action: 'add', value: { id: workers.blair } }
		});
	}

	return { ids, answers, workers };
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

const rowText = async (page: Page, id: string) =>
	((await page.locator('[data-map-table-row="' + id + '"]').textContent()) ?? '').replace(
		/\s+/g,
		' '
	);

test('@ticket-07 a Worker holding two secondary values refuses only the Sub-grouping', async ({
	page,
	request
}) => {
	const seeded = await seedPaired(request, ['alex', 'blair', 'casey', 'frankie', 'gray']);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/mapping?group=' + seeded.ids.loc + '&sub=' + seeded.ids.job);
	await waitForMapReady(page);

	// The primary Location Grouping still draws: only the nested Job partition is off.
	await expect.poll(() => page.locator(regionOutlines).count()).toBeGreaterThan(0);
	expect(await nodeIds(page)).toHaveLength(5);
	expect(await rowIds(page)).toHaveLength(5);
	expect(new URL(page.url()).searchParams.get('sub')).toBe(seeded.ids.job);
	expect(new URL(page.url()).searchParams.get('layout')).toBeNull();

	// The table keeps the primary group and shows no invented secondary.
	const alexRow = await rowText(page, seeded.workers.alex);
	expect(alexRow).toContain('Central');
	expect(alexRow).not.toContain('Cashier');
	expect(alexRow).not.toContain('Stocker');

	// The refusal explains the Worker's pairs, and the option stays visible and marked.
	await openGroupMenu(page);
	await expect(page.getByTestId('map-sub-grouping-status')).toContainText('Job');
	await expect(page.getByTestId('map-sub-grouping-status')).toContainText('Alex');
	await expect(page.getByTestId('map-sub-grouping-status')).toContainText('Cashier');
	await expect(page.getByTestId('map-sub-grouping-status')).toContainText('Stocker');
	// The reason explains independent Attribute values, not the retired assignment pairing.
	const reason = page.getByTestId('map-sub-grouping-reason');
	await expect(reason).toContainText('Job holds independent values');
	await expect(reason).not.toContainText('assignment');
	await page.getByLabel('Sub-group by').click();
	await expect(page.getByRole('option', { name: 'Job (unavailable)' })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');

	// A reload keeps the retained choice, the grouped primary and the refusal.
	await page.reload();
	await waitForMapReady(page);
	await expect(page.locator(regionOutlines).first()).toBeVisible();
	await openGroupMenu(page);
	await expect(page.getByTestId('map-sub-grouping-status')).toBeVisible();
});

test('@ticket-07 narrowing keeps one dot per Worker and the Sub-grouping stays refused over independent values', async ({
	page,
	request
}) => {
	const seeded = await seedPaired(request, ['alex', 'blair', 'casey', 'frankie']);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(
		'/mapping?group=' +
			seeded.ids.loc +
			'&sub=' +
			seeded.ids.job +
			'&f=' +
			seeded.ids.loc +
			':' +
			seeded.answers.storeB
	);
	await waitForMapReady(page);

	// The Store B population is Alex, Blair and Frankie; Casey holds only Central.
	const expected = [seeded.workers.alex, seeded.workers.blair, seeded.workers.frankie].sort();
	expect(await nodeIds(page)).toEqual(expected);
	expect(await rowIds(page)).toEqual(expected);

	// Alex and Blair still hold Cashier and Stocker independently: the Sub-grouping
	// refuses rather than fabricating a single Job from the Location filter.
	await openGroupMenu(page);
	await expect(page.getByTestId('map-sub-grouping-status')).toBeVisible();
	await expect(page.getByTestId('map-sub-grouping-status')).toContainText('Cashier');
	await expect(page.getByTestId('map-sub-grouping-status')).toContainText('Stocker');

	// One region per Worker still means exactly one dot and one row per Worker.
	for (const id of expected) {
		await expect(page.locator(`g[data-node-id="${id}"]`)).toHaveCount(1);
		await expect(page.locator(`[data-map-table-row="${id}"]`)).toHaveCount(1);
	}

	// A valid restored view keeps the same nodes, rows and Relationships.
	await page.reload();
	await waitForMapReady(page);
	expect(await nodeIds(page)).toEqual(expected);
	expect(await rowIds(page)).toEqual(expected);
	await expect(page.locator('svg path[data-tie]')).toHaveCount(1);
});

test('@ticket-07 a Single-Select primary pairs with each held secondary value and refuses when it splits', async ({
	page,
	request
}) => {
	const seeded = await seedPaired(request, ['alex', 'blair', 'frankie']);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto('/mapping?group=' + seeded.ids.dept + '&sub=' + seeded.ids.job);
	await waitForMapReady(page);

	// Department still groups; Job is a Multi-Select that Alex and Blair hold twice, so
	// it pairs Front of House with both Cashier and Stocker and is off.
	await expect.poll(() => page.locator(regionOutlines).count()).toBeGreaterThan(0);
	await openGroupMenu(page);
	await expect(page.getByTestId('map-sub-grouping-status')).toContainText('Cashier');
	await expect(page.getByTestId('map-sub-grouping-status')).toContainText('Stocker');
	await page.keyboard.press('Escape');

	// The same population keeps one dot per Worker; the Sub-grouping is refused, never
	// resolved to one Job.
	expect(await nodeIds(page)).toEqual(
		[seeded.workers.alex, seeded.workers.blair, seeded.workers.frankie].sort()
	);
	const alexRow = await rowText(page, seeded.workers.alex);
	expect(alexRow).toContain('Front of House');
	expect(alexRow).not.toContain('Cashier');
	expect(alexRow).not.toContain('Stocker');
});
