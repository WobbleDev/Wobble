import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';
import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';

/**
 * My Committee: focusing the bullseye brings in a column of the Leaders beside the chart.
 * Its rows pin the same Worker the chart's dots do.
 */

async function seedCommittee(request: APIRequestContext) {
	const deptId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: deptId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House', 'Kitchen']
			}
		])
	});
	expect(configured.ok()).toBeTruthy();
	const crew: [string, string, string][] = [
		['Zara', 'Leader', 'Back of House'],
		['Ana', 'Leader', 'Front of House'],
		['Beto', 'Supporter', 'Front of House'],
		['Carla', 'Activist', 'Front of House'],
		['Diego', 'Disengaged', 'Back of House'],
		['Elena', 'Hostile', 'Back of House'],
		['Felipe', 'Supporter', 'Back of House'],
		['Gloria', 'Unassessed', 'Back of House'],
		['Hugo', 'Supporter', 'Back of House'],
		['Ines', 'Supporter', 'Front of House'],
		['Joel', 'Supporter', 'Kitchen']
	];
	// The Leaders come last, so their ties can name the Workers made before them: Ana knows
	// Beto, Carla and Diego; Zara knows only Beto.
	const ids = new Map<string, string>();
	for (const [name, assessment, dept] of crew.filter(([, kind]) => kind !== 'Leader')) {
		ids.set(
			name,
			await createWorker(request, { name, assessment, attributes: { [deptId]: dept } })
		);
	}
	const ties: Record<string, string[]> = { Ana: ['Beto', 'Carla', 'Diego'], Zara: ['Beto'] };
	for (const [name, assessment, dept] of crew.filter(([, kind]) => kind === 'Leader')) {
		await createWorker(request, {
			name,
			assessment,
			attributes: { [deptId]: dept },
			relationships: ties[name].map((tied) => ids.get(tied)!)
		});
	}
}

const edge = (page: Page) =>
	page.locator('[data-focus-toggle]:not([inert] *), [data-focus-back]:not([inert] *)');
const column = (page: Page) => page.locator('[data-committee-column]');
const members = (page: Page) => page.locator('[data-committee-member]');

test('lists the Leaders beside the focused bullseye, and hides at rest', async ({
	page,
	request
}) => {
	await seedCommittee(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	// At rest the column is out of the page: inert, and out of the reading order.
	await expect(column(page)).toHaveAttribute('inert', '');
	await expect(column(page)).toHaveCSS('opacity', '0');

	await edge(page).click();
	await expect(column(page)).not.toHaveAttribute('inert', '');
	await expect(column(page)).toHaveCSS('opacity', '1');
	await expect(column(page).getByRole('heading', { name: 'My Committee' })).toBeVisible();

	// Two Leaders, by name, under the Departments the dashboard groups by; the Department
	// with Workers and no Leader still stands there, saying so.
	await expect(members(page)).toHaveCount(2);
	await expect(members(page).first()).toContainText('Ana');
	await expect(members(page).last()).toContainText('Zara');
	const sections = column(page).locator('[data-committee-section]');
	await expect(sections).toHaveCount(3);
	await expect(sections.nth(0).getByRole('heading')).toContainText('Front of House');
	await expect(sections.nth(0).getByRole('heading')).toContainText('1 / 1');
	await expect(sections.nth(1)).toContainText('Zara');
	await expect(sections.nth(2).getByRole('heading')).toContainText('Kitchen');
	await expect(sections.nth(2).locator('[data-committee-gap]')).toHaveText('No Leader yet');

	// Each row says how many Workers it knows, in words for a screen reader.
	await expect(members(page).first().locator('[data-committee-ties]')).toHaveText(/3 ties/);
	await expect(members(page).last().locator('[data-committee-ties]')).toHaveText(/1 tie/);

	// Eleven Workers at 1 Leader per 5 need three Leaders: one is still missing.
	await expect(column(page).locator('[data-committee-coverage]')).toContainText('2 / 3 Leaders');
	await expect(column(page).locator('[data-committee-short]')).toHaveText('1 more needed');
});

test('a row pins that Leader on the chart, and a second press clears it', async ({
	page,
	request
}) => {
	await seedCommittee(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);
	await edge(page).click();

	const row = members(page).first();
	await expect(column(page).locator('[data-committee-detail]')).toHaveCount(0);
	await row.click();
	await expect(row).toHaveAttribute('aria-pressed', 'true');
	// The pinned Leader opens: how far their ties reach, and who they are, nearest ring first.
	const detail = column(page).locator('[data-committee-detail]');
	await expect(detail).toContainText('Out to Disengaged');
	await expect(detail).toContainText('Carla, Beto, Diego');
	const id = (await row.getAttribute('data-committee-member'))!;
	await expect(page.locator('circle[data-worker-id][data-selected]')).toHaveAttribute(
		'data-worker-id',
		id
	);

	await row.click();
	await expect(row).toHaveAttribute('aria-pressed', 'false');
	await expect(page.locator('circle[data-worker-id][data-selected]')).toHaveCount(0);

	// Returning to the dashboard drops a pin.
	await row.click();
	await expect(row).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await edge(page).click();
	await expect(row).toHaveAttribute('aria-pressed', 'false');
});

test('a long list fades at its foot until it is scrolled to the end', async ({ page, request }) => {
	expect((await request.put('/api/attributes', { data: wireDefinitions([]) })).ok()).toBeTruthy();
	for (const name of [
		'Ana',
		'Nico',
		'Olga',
		'Pablo',
		'Quinn',
		'Rosa',
		'Sam',
		'Tess',
		'Uma',
		'Vera',
		'Wes',
		'Xena'
	]) {
		await createWorker(request, { name, assessment: 'Leader' });
	}
	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto('/overview');
	await appReady(page);
	await edge(page).click();

	const region = column(page).locator('[data-scroll-region]');
	await expect(region).toHaveCSS('mask-image', /linear-gradient/);
	await region.evaluate((node) => node.scrollTo({ top: node.scrollHeight }));
	await expect(region).toHaveCSS('mask-image', 'none');
});

test('coverage marks stay inside their card at the narrow floor', async ({ page, request }) => {
	expect((await request.put('/api/attributes', { data: wireDefinitions([]) })).ok()).toBeTruthy();
	// Sixty Workers need twelve Leaders: more marks than the narrow card's row can hold.
	for (let index = 0; index < 60; index++) {
		await createWorker(request, {
			name: `Worker ${index}`,
			assessment: index < 8 ? 'Leader' : 'Supporter'
		});
	}
	await page.setViewportSize({ width: 1024, height: 640 });
	await page.goto('/overview');
	await appReady(page);

	const outside = await page.evaluate(
		() =>
			[...document.querySelectorAll('[data-dashboard] [data-coverage-marks]')].filter((marks) => {
				const card = marks.closest('section')!.getBoundingClientRect();
				const box = marks.getBoundingClientRect();
				return box.right > card.right - 1 || box.bottom > card.bottom + 1;
			}).length
	);
	expect(outside).toBe(0);
});

test('the coverage card carries the way in, flies in as the column head, and the page title follows', async ({
	page,
	request
}) => {
	await seedCommittee(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);

	// The toggle stands on the Committee coverage card, and nowhere else at rest.
	await expect(page.locator('[data-coverage-card] [data-focus-toggle]')).toBeVisible();
	await expect(page.locator('[data-focus-toggle]')).toHaveCount(1);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');

	await page.locator('[data-focus-toggle]').click();
	// The column's own flight is running: a script animation, not just the fade's transition.
	const flights = await column(page).evaluate(
		(el) => el.getAnimations().filter((animation) => !(animation instanceof CSSTransition)).length
	);
	expect(flights).toBe(1);
	await expect(column(page)).toHaveCSS('opacity', '1');

	// The page names where it is, and the trail's Overview crumb is a way back.
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Committee');
	await expect(page.locator('[data-focus-back]')).toBeVisible();
	await page.locator('[data-breadcrumb-back]').click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
	await expect(page.locator('[data-dashboard-root]')).toHaveAttribute('data-focused', 'false');
	await expect(page.locator('[data-coverage-card] [data-focus-toggle]')).toBeVisible();

	// The head's own button leaves too.
	await page.locator('[data-focus-toggle]').click();
	await page.locator('[data-focus-back]').click();
	await expect(page.locator('[data-dashboard-root]')).toHaveAttribute('data-focused', 'false');
});
