import { ARRIVAL_DURATION_MS } from '../src/lib/features/overview/overview-arrival-lifecycle.ts';
import { randomUUID } from 'node:crypto';
import { appReady } from './page-ready.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

/**
 * The Overview arrival on the dashboard (ticket 04): the existing controller
 * and lifecycle run unchanged, the dashboard root carries the arrival marker,
 * state and generation, and the Overall support figure counts up along the
 * support band's timing curve before settling on the exact value.
 */

const arrival = (page: Page) => page.locator('[data-overview-arrival]');
const overall = (page: Page) => page.getByRole('region', { name: 'Overall support' });
const dashboardRoot = (page: Page) => page.locator('[data-dashboard-root]');
const edge = (page: Page) => page.locator('[data-focus-edge]');

/**
 * The arrival runs 2400ms, so a single read can only ever catch one phase.
 * Poll from the navigation instead and require both phases to have shown.
 */
async function ranToCompletion(page: Page) {
	const seen = new Set<string>();
	await expect
		.poll(
			async () => {
				const state = await arrival(page).getAttribute('data-arrival-state');
				if (state) seen.add(state);
				return seen.has('running') && seen.has('complete');
			},
			{ timeout: 15_000 }
		)
		.toBe(true);
}

async function generation(page: Page): Promise<number> {
	return Number(await arrival(page).getAttribute('data-arrival-generation'));
}

async function seedOneLeader(request: APIRequestContext) {
	// A worker update names every defined Attribute, so the seed defines one first.
	const deptId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok()).toBeTruthy();
	await createWorker(request, {
		name: 'Ana',
		assessment: 'Leader',
		attributes: { [deptId]: 'Front of House' },
		agitations: []
	});
}

test('runs one arrival per Worksite activation and does not replay it on return', async ({
	page,
	request
}) => {
	await seedOneLeader(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');

	await ranToCompletion(page);
	await expect(arrival(page)).toHaveAttribute('data-arrival-generation', /\d+/);
	// The run settles on the exact figure, not a rounded-up count.
	await expect(overall(page)).toContainText('100%');

	await page.getByRole('link', { name: 'Workers' }).click();
	await expect(page).toHaveURL(/\/workers$/);
	await page.getByRole('link', { name: 'Overview' }).click();
	await expect(page).toHaveURL(/\/overview$/);
	await expect(arrival(page)).toHaveAttribute('data-arrival-state', 'idle');
	await expect(arrival(page)).not.toHaveAttribute('data-arrival-generation');
});

test('replays exactly one arrival when switching Worksites', async ({
	page,
	request,
	activeWorksite
}) => {
	test.setTimeout(120_000);
	await seedOneLeader(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);
	await ranToCompletion(page);
	const firstGeneration = await generation(page);

	const created = page.waitForResponse(
		(response) => response.url().endsWith('/api/worksite') && response.request().method() === 'POST'
	);
	await page.getByRole('button', { name: `Active Worksite: ${activeWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: 'New Worksite' }).click();
	await created;

	await ranToCompletion(page);
	// Exactly one arrival: the generation steps by one, never more.
	expect(await generation(page)).toBe(firstGeneration + 1);
	await expect(arrival(page)).toHaveAttribute('data-arrival-state', 'complete', {
		timeout: ARRIVAL_DURATION_MS + 500
	});
});

test('shows the final figure at once when reduced motion is requested', async ({
	page,
	request
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await seedOneLeader(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');

	// Settled on first paint: no running phase, final value immediately.
	await expect(arrival(page)).toHaveAttribute('data-arrival-state', 'complete');
	await appReady(page);
	await expect(overall(page)).toContainText('100%');
	// Under reduced motion the fitted chart stands in for the ground, settled too.
	await expect(page.locator('.no-scroll-chart')).toBeVisible();
});

test('resets focus to rest on every new arrival', async ({ page, request, activeWorksite }) => {
	test.setTimeout(120_000);
	await seedOneLeader(request);
	await page.setViewportSize({ width: 1440, height: 874 });
	await page.goto('/overview');
	await appReady(page);
	await expect(arrival(page)).toHaveAttribute('data-arrival-state', 'complete', {
		timeout: 15_000
	});

	// A Worksite switch claims a new arrival on this route: focus returns to rest.
	await edge(page).click();
	await expect(dashboardRoot(page)).toHaveAttribute('data-focused', 'true');
	const created = page.waitForResponse(
		(response) => response.url().endsWith('/api/worksite') && response.request().method() === 'POST'
	);
	await page.getByRole('button', { name: `Active Worksite: ${activeWorksite.name}` }).click();
	await page.getByRole('menuitem', { name: 'New Worksite' }).click();
	await created;
	// A new Worksite opens the setup dialog over the page; skip it to reach the edge.
	await page
		.getByRole('dialog', { name: 'Set up your worksite' })
		.getByRole('button', { name: 'Skip setup' })
		.click();
	await expect(dashboardRoot(page)).toHaveAttribute('data-focused', 'false');
	await expect(arrival(page)).toHaveAttribute('data-arrival-state', 'complete', {
		timeout: 15_000
	});

	// Leaving and returning is an arrival without a replay: rest either way.
	await edge(page).click();
	await expect(dashboardRoot(page)).toHaveAttribute('data-focused', 'true');
	await page.getByRole('link', { name: 'Workers' }).click();
	await expect(page).toHaveURL(/\/workers$/);
	await page.getByRole('link', { name: 'Overview' }).click();
	await expect(page).toHaveURL(/\/overview$/);
	await expect(dashboardRoot(page)).toHaveAttribute('data-focused', 'false');
	await expect(arrival(page)).toHaveAttribute('data-arrival-state', 'idle');
});
