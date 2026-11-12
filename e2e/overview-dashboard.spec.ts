import { appReady } from './page-ready.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { clippedContent, expect, scrollableOverflow, test, testId } from './fixtures.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import { createWorker } from './api.ts';

/**
 * The Overview dashboard over the faded bullseye floor (ticket 01): four
 * readings on one screen, the chosen Attribute in by=, and a chart backdrop that is
 * faded, blurred and inert at rest.
 */

type DashboardSeed = { deptId: string; roleId: string };

async function seedDashboard(request: APIRequestContext): Promise<DashboardSeed> {
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
			{ id: roleId, name: 'Role', kind: 'category', options: ['Cook', 'Server'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const pay = await request.post('/api/agitations', { data: { text: 'Pay' } });
	expect(pay.ok()).toBeTruthy();
	const payId = (await pay.json()).agitation.id as string;
	const hours = await request.post('/api/agitations', { data: { text: 'Hours' } });
	expect(hours.ok()).toBeTruthy();
	const hoursId = (await hours.json()).agitation.id as string;
	const snacks = await request.post('/api/agitations', { data: { text: 'Snacks' } });
	expect(snacks.ok()).toBeTruthy();
	const snacksId = (await snacks.json()).agitation.id as string;

	const crew: {
		name: string;
		assessment: string;
		dept: string;
		role: string;
		agitations: string[];
	}[] = [
		{
			name: 'Ana',
			assessment: 'Leader',
			dept: 'Front of House',
			role: 'Cook',
			agitations: [payId]
		},
		{
			name: 'Beto',
			assessment: 'Supporter',
			dept: 'Front of House',
			role: 'Cook',
			agitations: [payId, hoursId, snacksId]
		},
		{
			name: 'Carla',
			assessment: 'Activist',
			dept: 'Front of House',
			role: 'Server',
			agitations: [hoursId]
		},
		{
			name: 'Diego',
			assessment: 'Disengaged',
			dept: 'Back of House',
			role: 'Cook',
			agitations: []
		},
		{
			name: 'Elena',
			assessment: 'Hostile',
			dept: 'Back of House',
			role: 'Cook',
			agitations: [payId]
		},
		{
			name: 'Felipe',
			assessment: 'Supporter',
			dept: 'Back of House',
			role: 'Server',
			agitations: []
		},
		{
			name: 'Gloria',
			assessment: 'Unassessed',
			dept: 'Back of House',
			role: 'Server',
			agitations: []
		},
		{
			name: 'Hugo',
			assessment: 'Supporter',
			dept: 'Back of House',
			role: 'Server',
			agitations: [payId]
		}
	];
	for (const worker of crew) {
		await createWorker(request, {
			name: worker.name,
			assessment: worker.assessment,
			attributes: { [deptId]: worker.dept, [roleId]: worker.role },
			agitations: worker.agitations
		});
	}
	return { deptId, roleId };
}

const overallCard = (page: Page) => page.getByRole('region', { name: 'Overall support' });
const coverageCard = (page: Page) => page.getByRole('region', { name: 'Committee coverage' });
const byCard = (page: Page, name: string) => page.getByRole('region', { name: 'By ' + name });
const agitationsCard = (page: Page) => page.getByRole('region', { name: 'Agitations' });
const chartBackdrop = (page: Page) => page.locator('[data-bullseye-base]');
const dots = (page: Page) => page.locator('[data-bullseye-base] circle[data-worker-id]');

test('shows Overall support and Committee coverage figures', async ({ page, request }) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	const overall = overallCard(page);
	await expect(overall).toContainText('63');
	await expect(overall).toContainText('5 of 8, of all Workers');
	// One segment per held standing, each naming its count at 5% of the bar and above.
	await expect(overall.locator('.seg')).toHaveCount(6);
	await expect(overall.getByRole('button', { name: '3 Supporters' })).toBeVisible();

	const coverage = coverageCard(page);
	await expect(coverage).toContainText('Leaders 1 · needed 2');
	await expect(coverage).toContainText('short of target');
	await expect(coverage).toContainText('1 Leader per 5 workers, of all Workers');
});

test('bands each Department group with its support bar and coverage', async ({ page, request }) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	const by = byCard(page, 'Department');
	await expect(by.getByRole('button', { name: 'Department' })).toBeVisible();
	await expect(by).toContainText('Front of House');
	await expect(by).toContainText('100%');
	await expect(by).toContainText('Leaders 1 · needed 1 · of Front of House');
	await expect(by).toContainText('Back of House');
	await expect(by).toContainText('40%');
	await expect(by).toContainText('Leaders 0 · needed 1 · of Back of House');
});

test('shades the Agitations matrix with no shade key', async ({ page, request }) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	const matrix = agitationsCard(page);
	await expect(matrix.locator('table[data-agitations-headers] thead th').nth(1)).toBeVisible();
	await expect(matrix.locator('p.sr-only')).toHaveText(
		'Worker counts by Department. Select a count to view Workers.'
	);
	await expect(matrix.locator('table[data-agitations-headers] thead th').nth(1)).toContainText(
		'All (8)'
	);
	await expect(
		matrix.locator('table[data-agitations-headers] thead th[title="Front of House"]')
	).toContainText(/Front of House\s*\(3\)/);
	await expect(
		matrix.locator('table[data-agitations-headers] thead th[title="Back of House"]')
	).toContainText(/Back of House\s*\(5\)/);
	const help = matrix.getByRole('button', { name: 'How to read Agitations' });
	await help.press('Shift+Tab');
	await page.keyboard.press('Tab');
	await expect(help).toHaveAttribute('aria-describedby', /.+/);
	const descriptionId = await help.getAttribute('aria-describedby');
	const description = page.locator(`[id="${descriptionId}"]`);
	await expect(description).toBeVisible();
	await expect(description).toContainText(
		'Worker counts by Department. Select a count to view Workers.'
	);
	await expect(description).toContainText(
		'The All column shows worksite totals. Shading uses the same count scale on every page.'
	);
	const pay = matrix.getByRole('row', { name: /Pay/ });
	await expect(pay).toContainText('4');
	await expect(
		pay.getByRole('link', { name: 'View 4 Workers holding Pay across the worksite', exact: true })
	).toHaveText('4');
	await expect(
		pay.getByRole('link', { name: 'View 2 Workers holding Pay in Front of House', exact: true })
	).toHaveText('2');
	const hours = matrix.getByRole('row', { name: /Hours/ });
	await expect(hours).toContainText('2');

	// The legend is gone: no key beside the title, and a fitting matrix keeps a disabled footer.
	await expect(matrix.locator('div[aria-hidden="true"]')).toHaveCount(0);
	const controls = matrix.locator('[data-agitations-page-controls]');
	await expect(controls).toBeVisible();
	await expect(controls.locator('[data-group-range]')).toHaveText('Groups 1–2 of 2');
	await expect(controls.getByRole('button', { name: 'Previous agitations page' })).toBeDisabled();
	await expect(controls.getByRole('button', { name: 'Next agitations page' })).toBeDisabled();
	// Full heat reads white, half heat black, and the cold cell keeps the default ink.
	await expect(matrix.locator('td.text-white')).toHaveCount(3);
	await expect(matrix.locator('td.text-black')).toHaveCount(1);
});

test('rests the bullseye floor faded, blurred and inert behind the cards', async ({
	page,
	request
}) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	await expect(chartBackdrop(page)).toBeVisible();
	await expect(chartBackdrop(page)).toHaveAttribute('inert', '');
	await expect(chartBackdrop(page)).toHaveAttribute('aria-hidden', 'true');

	// Opacity and blur sit on the drawing, not the layer.
	const drawing = chartBackdrop(page).locator('svg').first();
	await expect(drawing).toHaveCSS('opacity', '0.3');
	const filter = await drawing.evaluate((el) => getComputedStyle(el).filter);
	expect(filter).toContain('blur(2px)');

	// The layer keeps the floor placement: 1.4x the frame height at rest scale.
	const placement = await page.evaluate(() => {
		const base = document.querySelector('[data-bullseye-base]') as HTMLElement;
		const layer = document.querySelector('[data-bullseye-layer]') as HTMLElement;
		return { frame: base.clientHeight, width: layer.getBoundingClientRect().width };
	});
	expect(placement.width).toBeCloseTo(placement.frame * 1.4, 0);
});

test('draws Hostile without a halo and keeps the band annuli', async ({ page, request }) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	// Each band is a true annulus, with the inner boundary drawn as its own dashed circle.
	await expect(chartBackdrop(page).locator('svg circle[stroke-dasharray]')).not.toHaveCount(0);
	await expect(chartBackdrop(page).locator('svg path[fill]:not([fill="none"])')).not.toHaveCount(0);

	const strokes = await dots(page).evaluateAll((elements) =>
		elements.map((el) => ({
			fill: el.getAttribute('fill'),
			stroke: el.getAttribute('stroke')
		}))
	);
	const hostileStrokes = strokes.filter((dot) => dot.fill === 'var(--assess-hostile)');
	expect(hostileStrokes.length).toBeGreaterThan(0);
	for (const dot of hostileStrokes) expect(dot.stroke).toBe('none');
	const leaderStrokes = strokes.filter((dot) => dot.fill === 'var(--assess-leader)');
	expect(leaderStrokes.length).toBeGreaterThan(0);
	for (const dot of leaderStrokes) expect(dot.stroke).not.toBe('none');

	const label = chartBackdrop(page).locator('text.ring-label:has-text("Hostile")');
	await expect(label).toHaveAttribute('stroke', 'none');
});

test('draws the fitted chart without a Hostile halo where the chart backdrop cannot be dragged', async ({
	page,
	request
}) => {
	await seedDashboard(request);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	await expect(chartBackdrop(page)).toHaveCount(0);
	const strokes = await page.locator('circle[data-worker-id]').evaluateAll((elements) =>
		elements.map((el) => ({
			fill: el.getAttribute('fill'),
			stroke: el.getAttribute('stroke')
		}))
	);
	const hostileStrokes = strokes.filter((dot) => dot.fill === 'var(--assess-hostile)');
	expect(hostileStrokes.length).toBeGreaterThan(0);
	for (const dot of hostileStrokes) expect(dot.stroke).toBe('none');
});

test('keeps the chosen Attribute in by= over reload and falls back to Department', async ({
	page,
	request
}) => {
	const seed = await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });

	// A Role address shows Role groups.
	await page.goto('/overview?by=' + seed.roleId);
	await appReady(page);
	await expect(byCard(page, 'Role')).toBeVisible();
	await expect(byCard(page, 'Role')).toContainText('Cook');
	await expect(byCard(page, 'Role')).toContainText('Server');

	// Changing the Select rewrites by= without a new history entry.
	await page.goto('/overview');
	await appReady(page);
	await expect(byCard(page, 'Department')).toBeVisible();
	await byCard(page, 'Department').getByRole('button', { name: 'Department' }).click();
	await page.getByRole('option', { name: 'Role' }).click();
	await expect(page).toHaveURL(/by=/);
	expect(page.url()).toContain('by=' + seed.roleId);
	await page.reload();
	await appReady(page);
	await expect(byCard(page, 'Role')).toBeVisible();

	// An unknown by= falls back to Department; dropped tab, x and context params stay ignored.
	await page.goto('/overview?by=no-such-attribute&tab=agitations&x=1');
	await appReady(page);
	await expect(byCard(page, 'Department')).toBeVisible();
	await expect(byCard(page, 'Department')).toContainText('Front of House');
	await expect(page.locator('[data-overview-switch]')).toHaveCount(0);
});

test('clicks through the inert floor and keeps dots out of the tab order', async ({
	page,
	request
}) => {
	await seedDashboard(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);
	await expect(overallCard(page)).toBeVisible();

	// The chart backdrop's dots sit behind the dashboard. Clicking through must land on
	// the dashboard, never on a dot — but it must also not land on a dashboard
	// link, which would navigate to /workers and unmount the chart backdrop. Find a dot
	// whose centre resolves to non-interactive dashboard background.
	const total = await dots(page).count();
	let point: { x: number; y: number } | undefined;
	let target = dots(page).first();
	for (let index = 0; index < total; index += 1) {
		const candidate = dots(page).nth(index);
		const box = await candidate.boundingBox();
		if (!box) continue;
		const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		const hit = await page.evaluate((p: { x: number; y: number }) => {
			const el = document.elementFromPoint(p.x, p.y);
			if (!el) return 'none';
			if (el.closest('[data-worker-id]')) return 'dot';
			if (el.closest('a, button, [role="button"], [data-focus-edge], [data-focus-reset]'))
				return 'interactive';
			return 'background';
		}, at);
		if (hit === 'background') {
			point = at;
			target = candidate;
			break;
		}
	}
	expect(point, 'a dot over non-interactive dashboard background').toBeDefined();

	// No pointer event reaches a dot: the point resolves to something else.
	const hitsDot = await page.evaluate((at: { x: number; y: number }) => {
		const hit = document.elementFromPoint(at.x, at.y);
		return hit !== null && hit.closest('[data-worker-id]') !== null;
	}, point!);
	expect(hitsDot).toBe(false);

	await page.mouse.click(point!.x, point!.y);
	await expect(page).toHaveURL(/\/overview/);
	await expect(page.locator('circle[data-worker-id][data-selected]')).toHaveCount(0);
	await expect(page.locator('[data-bullseye-callout]')).toHaveCount(0);

	// A dot cannot take focus while the chart backdrop is inert.
	const focused = await target.evaluate((el) => {
		(el as SVGCircleElement).focus();
		return document.activeElement === el;
	});
	expect(focused).toBe(false);
});

test('never scrolls the page at the floor sizes', async ({ page, request }) => {
	await seedDashboard(request);
	for (const size of [
		{ width: 1024, height: 640 },
		{ width: 1440, height: 874 }
	]) {
		await page.setViewportSize(size);
		await page.goto('/overview');
		await appReady(page);

		await expect(overallCard(page)).toBeVisible();
		expect(await scrollableOverflow(page)).toBe(0);
		expect(await clippedContent(page)).toEqual([]);
	}
});

test.describe('in Spanish', () => {
	test.use({ locale: 'es-MX' });

	test('reads the dashboard labels in Spanish', async ({ page, request }) => {
		const deptId = testId();
		const configured = await request.put('/api/attributes', {
			data: wireDefinitions([
				{ id: deptId, name: 'Department', kind: 'category', options: ['Front of House'] }
			])
		});
		expect(configured.ok()).toBeTruthy();
		const pay = await request.post('/api/agitations', { data: { text: 'Pago' } });
		const payId = (await pay.json()).agitation.id as string;
		await createWorker(request, {
			name: 'Ana',
			assessment: 'Leader',
			attributes: { [deptId]: 'Front of House' },
			agitations: [payId]
		});

		await page.setViewportSize({ width: 1440, height: 874 });
		await page.goto('/overview');
		await appReady(page);

		await expect(page.getByRole('region', { name: 'Apoyo general' })).toContainText(
			'1 de 1, de todos los trabajadores'
		);
		await expect(page.getByRole('region', { name: 'Apoyo general' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Por', exact: true })).toBeVisible();
		await expect(page.getByText('Líderes 1 · necesarios 1 · de Front of House')).toBeVisible();
		await expect(page.getByRole('columnheader', { name: 'Todos' })).toBeVisible();
		await expect(page.getByRole('region', { name: 'Agitaciones' })).toBeVisible();
		const matrix = page.getByRole('region', { name: 'Agitaciones' });
		await expect(matrix).toContainText(
			'Trabajadores por Department. Selecciona una cifra para ver a los trabajadores.'
		);
		await expect(matrix.getByRole('columnheader', { name: /Todos/ })).toContainText('(1)');
		await expect(
			matrix.locator('table[data-agitations-headers] thead th[title="Front of House"]')
		).toContainText('(1)');
	});
});
test.describe('E6 folds product-gap-03 overview reading', () => {
	type Seeded = {
		departmentId: string;
		rolesId: string;
		workerIds: Record<string, string>;
	};

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const suffix = testId().slice(0, 8);
		const departmentId = `department-${suffix}`;
		const rolesId = `roles-${suffix}`;

		const configured = await request.put('/api/attributes', {
			data: wireDefinitions([
				{
					id: departmentId,
					name: 'Department',
					kind: 'category',
					options: ['Packing', 'Delivery', 'No Department']
				},
				{ id: rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
			])
		});
		expect(configured.ok(), await configured.text()).toBeTruthy();

		const people = [
			{ name: 'Alex', assessment: 'Leader', department: 'Packing', roles: ['Trainer'] },
			{
				name: 'Blair',
				assessment: 'Supporter',
				department: 'Delivery',
				roles: ['Trainer', 'Steward']
			},
			{ name: 'Casey', assessment: 'Unassessed', department: '', roles: [] },
			{ name: 'Drew', assessment: 'Activist', department: 'No Department', roles: [] }
		] as const;

		const workerIds: Record<string, string> = {};
		for (const person of people) {
			const created = await request.post('/api/workers', {
				data: {
					name: person.name,
					email: '',
					phone: '',
					assessment: person.assessment,
					attributes: wireWorkerAttributes({
						[departmentId]: person.department,
						[rolesId]: person.roles
					}),
					agitations: [],
					languages: [],
					relationships: [],
					notes: []
				}
			});
			expect(created.status(), await created.text()).toBe(201);
			workerIds[person.name] = ((await created.json()) as { worker: { id: string } }).worker.id;
		}

		// The fixture's two Relationships, written after every Worker exists.
		await putWorker(request, workerIds.Alex, {
			name: 'Alex',
			assessment: 'Leader',
			attributes: wireWorkerAttributes({ [departmentId]: 'Packing', [rolesId]: ['Trainer'] }),
			relationships: [workerIds.Blair]
		});
		await putWorker(request, workerIds.Blair, {
			name: 'Blair',
			assessment: 'Supporter',
			attributes: wireWorkerAttributes({
				[departmentId]: 'Delivery',
				[rolesId]: ['Trainer', 'Steward']
			}),
			relationships: [workerIds.Alex, workerIds.Casey]
		});

		return { departmentId, rolesId, workerIds };
	}

	/** Replaces one Worker's record; the fixture only needs Relationships to change. */
	async function putWorker(
		request: APIRequestContext,
		id: string,
		worker: {
			name: string;
			assessment: string;
			attributes: Record<string, string | string[]>;
			relationships: string[];
		}
	): Promise<void> {
		const updated = await request.put(`/api/workers/${id}`, {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: worker.assessment,
				attributes: worker.attributes,
				agitations: [],
				languages: [],
				relationships: worker.relationships,
				notes: []
			}
		});
		expect(updated.ok(), await updated.text()).toBeTruthy();
	}

	/** Renames the Attribute while keeping every answer id, then reloads the view. */
	async function renameDepartmentToTeam(
		request: APIRequestContext,
		page: Page,
		seeded: Seeded,
		path: string
	): Promise<void> {
		const renamed = await request.put('/api/attributes', {
			data: wireDefinitions([
				{
					id: seeded.departmentId,
					name: 'Team',
					kind: 'category',
					options: ['Packing', 'Delivery', 'No Department']
				},
				{ id: seeded.rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
			])
		});
		expect(renamed.ok(), await renamed.text()).toBeTruthy();
		await page.goto(path);
		await appReady(page);
	}
	test('@product-gap-03 Overview names each configured Attribute in the By choice', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await page.goto('/overview');
		await appReady(page);

		const byDepartment = page.getByRole('region', { name: 'By Department' });
		await expect(byDepartment).toBeVisible();
		// The By choice offers the Single-Select Attributes by configured name.
		await byDepartment.getByRole('button', { name: 'Department' }).click();
		await expect(page.getByRole('option')).toHaveText(['Department']);
		// No type terminology survives in the reading.
		await expect(page.getByText(/Category/)).toHaveCount(0);
		await page.keyboard.press('Escape');

		// A rename changes the word the reading uses, because it reads the configured name.
		await renameDepartmentToTeam(request, page, seeded, '/overview');
		await expect(page.getByRole('region', { name: 'By Team' })).toBeVisible();

		// A Multi-Select Attribute alone offers no grouping: the card says so plainly.
		const onlyMulti = await request.put('/api/attributes', {
			data: wireDefinitions([
				{ id: seeded.rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
			])
		});
		expect(onlyMulti.ok(), await onlyMulti.text()).toBeTruthy();
		await page.reload();
		await appReady(page);
		const byCard = page.getByRole('region', { name: /^By/ });
		await expect(byCard).toContainText(
			'Nothing available to group by. Configure a grouping in Configuration.'
		);
		await expect(byCard.locator('ul li a[title]')).toHaveCount(0);

		// With no configured Attribute there is still nothing available to group by.
		const none = await request.put('/api/attributes', { data: [] });
		expect(none.ok(), await none.text()).toBeTruthy();
		await page.reload();
		await appReady(page);
		await expect(page.getByRole('region', { name: /^By/ })).toContainText(
			'Nothing available to group by. Configure a grouping in Configuration.'
		);
	});
});
