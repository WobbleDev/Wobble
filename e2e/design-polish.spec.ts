import { randomUUID } from 'node:crypto';
import { appReady, gotoConfiguration } from './page-ready.ts';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import { createWorker } from './api.ts';

/**
 * Ticket 11 — labels, contrast, explanations, and the Worksite-action scope.
 * The settled contrast numbers live in `src/routes/layout.spec.ts`, which
 * re-measures the tokens; here the behaviors that carry them are read.
 */
/**
 * Workers with a real standing, which the bullseye plots. A new Worksite ships
 * with default Attributes and every configured one must be present on a Worker,
 * so they are cleared first — neither the Overview nor the chart reads one.
 */
async function seedWorkers(request: APIRequestContext, names: string[]) {
	expect((await request.put('/api/attributes', { data: wireDefinitions([]) })).ok()).toBeTruthy();

	for (const name of names) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Supporter',
				attributes: wireWorkerAttributes({}),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}
}

test('Overview names the standings that count as Support', async ({ page, request }) => {
	await seedWorkers(request, ['Ada Lovelace', 'Grace Hopper']);
	await page.goto('/overview');
	await appReady(page);

	const band = page.getByRole('region', { name: 'Overall support' });
	await expect(band.getByRole('heading', { name: 'Overall support' })).toBeVisible();
	// The band no longer prints which standings count as support.
	await expect(band).not.toContainText('Support: Leader, Activist and Supporter.');
});

test('the bullseye help names the controls and Reset zoom returns the scale', async ({
	page,
	request
}) => {
	await seedWorkers(request, ['Ada Lovelace', 'Grace Hopper']);
	await page.goto('/overview');
	await appReady(page);
	await expect(page.locator('[data-worker-id]').first()).toBeAttached();

	// The help is a tooltip beside the title: it takes no column height, and a
	// keyboard reader reaches it by focusing the button. This viewport draws the
	// ground, so its copy is the dragged form.
	const help = page.getByRole('button', { name: 'How to read the chart' });
	await expect(page.getByText('arrow keys move')).toBeHidden();
	await help.focus();
	await expect(page.getByText('Drag to move the chart, scroll to zoom it.')).toBeVisible();
	await expect(page.getByText('arrow keys move')).toBeVisible();
	await page.keyboard.press('Escape');

	// The visible label names the button; no aria-label overrides it (WCAG 2.5.3).
	const reset = page.getByRole('button', { name: 'Reset zoom' });
	await expect(reset).toHaveCount(0);

	// Reset zoom is offered only while the bullseye is focused.
	await page.getByRole('button', { name: 'Focus bullseye' }).click();
	await expect(reset).toBeDisabled();

	// It stands clear of the column, fixed at the lower right of the screen, and
	// the bullseye ground's pass-through does not swallow the click.
	const box = await reset.boundingBox();
	const viewport = page.viewportSize()!;
	expect(box!.x).toBeGreaterThan(viewport.width / 2);
	expect(Math.abs(viewport.width - (box!.x + box!.width) - 24)).toBeLessThan(2);
	expect(Math.abs(viewport.height - (box!.y + box!.height) - 24)).toBeLessThan(2);

	// Plus zooms the chart through the existing key handler, which arms reset.
	await page.locator('[data-worker-id]').first().focus();
	await page.keyboard.press('+');
	await expect(reset).toBeEnabled();

	await reset.click();
	await expect(reset).toBeDisabled();
});

test('essential field labels read as 12px sentence sans; Overview card titles read as sentence-case section titles', async ({
	page,
	request
}) => {
	// A per-test id: attribute ids are owned globally across Worksites, so a
	// hardcoded literal is claimed by whichever browser project runs first and
	// the other project's copy is rejected at setup (the pre-existing collision).
	const departmentId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: departmentId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	await page.goto('/mapping');
	await appReady(page);
	await page.getByRole('button', { name: /^Group(:|$)/ }).click();
	const groupLabel = page.getByText('Group by', { exact: true });
	await expect(groupLabel).toBeVisible();
	await expect(groupLabel).toHaveCSS('font-size', '12px');
	await expect(groupLabel).toHaveCSS('text-transform', 'none');

	await page.goto('/overview');
	await appReady(page);
	const cardTitle = page.getByRole('heading', { name: 'Overall support' });
	await expect(cardTitle).toHaveCSS('text-transform', 'none');
	await expect(cardTitle).toHaveCSS('font-size', '16px');
});

test('the Agitations matrix column headers read as uppercase mono eyebrows', async ({
	page,
	request
}) => {
	// One Worker holding one Agitation against one Single-Select Attribute, reusing
	// the Overview dashboard seeding helpers: enough for the matrix to draw its
	// All column alongside one group column.
	const departmentId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: departmentId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const pay = await request.post('/api/agitations', { data: { text: 'Pay' } });
	expect(pay.ok(), await pay.text()).toBeTruthy();
	const payId = (await pay.json()).agitation.id as string;

	await createWorker(request, {
		name: 'Ana',
		assessment: 'Supporter',
		attributes: { [departmentId]: 'Front of House' },
		agitations: [payId]
	});

	await page.goto('/overview');
	await appReady(page);

	const matrix = page.getByRole('region', { name: 'Agitations' });
	const allHeader = matrix.getByRole('columnheader', { name: 'All' });
	await expect(allHeader).toBeVisible();
	await expect(allHeader).toHaveCSS('text-transform', 'uppercase');
	await expect(allHeader).toHaveCSS('font-size', '11px');
	await expect(allHeader).toHaveCSS('font-family', /mono/i);
});

test('the Configuration toolbar keeps its settled state in the new ink', async ({ page }) => {
	await gotoConfiguration(page);

	// Dirtying the form raises the sections line the scoped rule re-inks. It takes
	// a submitted agitation: half-typed input is not yet a dirty section.
	await page.getByLabel('Add an agitation').fill('Canvassing');
	await page
		.getByRole('button', { name: 'Add', exact: true })
		.and(page.locator(':enabled'))
		.click();
	// Several live status regions coexist on this page — the persistent save
	// announcement and the attribute-move announcement are both role="status" —
	// so read the message from the save bar's own region, not the page-wide role.
	await expect(page.getByTestId('configuration-save-bar').getByRole('status')).toContainText(
		'Unsaved changes'
	);
	await expect(page.getByText('Agitations').first()).toBeVisible();
});

const dataViews = ['/overview', '/workers', '/mapping'] as const;

test('Worksite actions stand on the data views', async ({ page }) => {
	for (const view of dataViews) {
		await page.goto(view);
		await appReady(page);
		// New Worker opens a row in the Workers table, so it stands on Workers only.
		await expect(page.getByRole('button', { name: 'New Worker' })).toHaveCount(
			view === '/workers' ? 1 : 0
		);
		await expect(page.getByRole('button', { name: 'Import contacts' })).toBeVisible();
	}
});

test('Worksite actions stay off Settings and Configuration', async ({ page }) => {
	for (const view of ['/settings', '/configuration'] as const) {
		if (view === '/configuration') await gotoConfiguration(page);
		else {
			await page.goto(view);
			await appReady(page);
		}
		await expect(page.getByRole('button', { name: 'New Worker' })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Import contacts' })).toHaveCount(0);
	}
});

test('the global dialogs open from each permitted view', async ({ page }) => {
	for (const view of dataViews) {
		await page.goto(view);
		await appReady(page);

		await page.getByRole('button', { name: 'Import contacts' }).click();
		await expect(page.getByRole('dialog', { name: 'Import contacts from CSV' })).toBeVisible();
		await page.keyboard.press('Escape');
	}
});
