import {
	copyFileSync,
	existsSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, TEST_PASSPHRASE } from './fixtures.ts';
import { createWorker, readStoredActiveWorksiteId } from './api.ts';
import { appReady } from './page-ready.ts';
import type { APIRequestContext, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

/** Restore sources written under os.tmpdir(); removed after every test. */
const tempSources: string[] = [];

test.afterEach(() => {
	for (const path of tempSources) rmSync(path, { force: true });
	tempSources.length = 0;
});

const option = (page: Page, name: string) => page.getByRole('radio', { name });

const waitForSettingsSave = (page: Page) =>
	page.waitForResponse(
		(response) => response.url().endsWith('/api/settings') && response.request().method() === 'PUT'
	);

const waitForSettingsReset = (page: Page) =>
	page.waitForResponse(
		(response) =>
			response.url().endsWith('/api/settings') && response.request().method() === 'DELETE'
	);

/** One Settings row, as the page marks it for the capability checks. */
const settingsRow = (page: Page, id: string) => page.locator(`[data-row="${id}"]`);

/** The path the core reports: it stores a canonical path, so /tmp resolves to /private/tmp. */
const databasePath = (): string => {
	const configured = process.env.WOBBLE_E2E_DB ?? '';
	expect(configured, 'run the settings suite with its own WOBBLE_E2E_DB').toBeTruthy();
	return realpathSync(configured);
};

const dispatchVisibilityChange = (page: Page) =>
	page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

/** Opens a Select picker by its labelledby title and chooses one option. */
const pick = async (page: Page, picker: string, choice: string) => {
	await page.getByRole('button', { name: picker }).click();
	await page.getByRole('option', { name: choice, exact: true }).click();
};

/** Flips a SettingsSwitch by its labelledby title. */
const toggleSwitch = (page: Page, name: string) => page.getByRole('switch', { name }).click();

/** The computed value of one of the root's custom properties. */
const rootVariable = (page: Page, name: string) =>
	page.evaluate(
		(variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
		name
	);

/** The Settings index link's transition, in seconds: a live, non-!important motion probe. */
const transitionSeconds = (page: Page) =>
	page
		.getByRole('navigation', { name: 'Settings sections' })
		.getByRole('link', { name: 'Theme', exact: true })
		.evaluate((node) => Number.parseFloat(getComputedStyle(node).transitionDuration));

/**
 * The root's own transition, probed with an inline 1s duration the reduced-motion rule
 * must override. A rule that only matches descendants leaves the root at 1s.
 */
const rootTransitionSeconds = (page: Page) =>
	page.evaluate(() => {
		const root = document.documentElement;
		root.style.transition = 'color 1s';
		const seconds = Number.parseFloat(getComputedStyle(root).transitionDuration);
		root.style.removeProperty('transition');
		return seconds;
	});

/**
 * Records the appearance attributes at DOMContentLoaded, after the inline head script
 * has run and before the app bundle can reconcile anything: the first paint.
 */
const recordFirstPaint = (page: Page) =>
	page.addInitScript(() => {
		document.addEventListener('DOMContentLoaded', () => {
			const root = document.documentElement;
			(window as unknown as { __firstPaint: Record<string, string | null> }).__firstPaint = {
				motion: root.dataset.motion ?? null,
				contrast: root.dataset.contrast ?? null,
				textSize: root.dataset.textSize ?? null,
				palette: root.dataset.assessmentPalette ?? null
			};
		});
	});

const readFirstPaint = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { __firstPaint?: Record<string, string | null> }).__firstPaint ?? null
	);

/** Start each accessibility test from the registry defaults, whatever earlier tests left. */
const resetSettings = async (page: Page) => {
	expect((await page.request.delete('/api/settings')).ok()).toBeTruthy();
};

/**
 * A Worker must answer every configured Attribute, so seed blanks for those: a
 * Single-Select takes the empty string and a Multi-Select an empty list.
 */
const blankAttributes = (request: APIRequestContext) =>
	request
		.get('/api/dataset')
		.then((response) => response.json())
		.then((dataset: { attributes: { id: string; kind: string }[] }) =>
			Object.fromEntries(
				dataset.attributes.map((attribute) => [
					attribute.id,
					attribute.kind === 'category' ? '' : []
				])
			)
		);

test('people can choose a shared appearance that ignores old browser values', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
	await page.goto('/overview');

	await page.getByRole('link', { name: 'Settings', exact: true }).click();
	await expect(page).toHaveURL('/settings');
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	await appReady(page);

	await expect(option(page, 'System')).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('html')).not.toHaveClass(/dark/);

	const darkSave = waitForSettingsSave(page);
	await option(page, 'Dark').click();
	expect((await darkSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveClass(/dark/);
	await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();

	const lightSave = waitForSettingsSave(page);
	await page.getByRole('button', { name: 'Switch to light theme' }).click();
	expect((await lightSave).ok()).toBeTruthy();
	await expect(page.locator('html')).not.toHaveClass(/dark/);

	await page.reload();
	await appReady(page);
	await expect(option(page, 'Light')).toHaveAttribute('aria-checked', 'true');

	const systemSave = waitForSettingsSave(page);
	await option(page, 'System').click();
	expect((await systemSave).ok()).toBeTruthy();
	await expect(page.locator('html')).not.toHaveClass(/dark/);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(page.locator('html')).toHaveClass(/dark/);
});

test('density scales the whole app and persists after reload', async ({ page }) => {
	await page.goto('/settings');
	await appReady(page);
	await expect(option(page, 'Standard')).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('html')).toHaveCSS('font-size', '16px');

	const compactSave = waitForSettingsSave(page);
	await option(page, 'Compact').click();
	expect((await compactSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveCSS('font-size', '15px');
	// The page title is 1.625rem, and the density setting moves the rem base rather
	// than the type step, so the heading's computed size is 1.625 × the base:
	// 24.375px at Compact, 27.625px at Comfortable.
	await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCSS('font-size', '24.375px');
	await page.reload();
	await appReady(page);
	await expect(option(page, 'Compact')).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('html')).toHaveCSS('font-size', '15px');

	const comfortableSave = waitForSettingsSave(page);
	await option(page, 'Comfortable').click();
	expect((await comfortableSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveCSS('font-size', '17px');
	await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCSS('font-size', '27.625px');
	await page.goto('/workers');
	await appReady(page);
	// Column headers take the .label step, max(0.6875rem, 11px) (see the Table.Head class
	// in data-table.svelte); at Comfortable's 17px root that is 11.6875px.
	await expect(page.getByRole('columnheader').first()).toHaveCSS('font-size', '11.6875px');
});

test('the section index reaches the last section at the foot of the page', async ({ page }) => {
	await page.goto('/settings');
	await appReady(page);

	const index = page.getByRole('navigation', { name: 'Settings sections' });
	await expect(index.getByRole('link', { name: 'Data', exact: true })).toHaveAttribute(
		'aria-current',
		'location'
	);

	// The Diagnostics and About wells resolve after the page paints and add height, so a
	// single jump can land short of the real foot. Scroll again until the foot holds.
	await expect(async () => {
		await page.getByTestId('tab-scroll-viewport').evaluate((node) => {
			node.scrollTo(0, node.scrollHeight);
		});
		await expect(index.getByRole('link', { name: 'Reset', exact: true })).toHaveAttribute(
			'aria-current',
			'location',
			{ timeout: 500 }
		);
	}).toPass({ timeout: 10_000 });
});

test('the section index does not move while the page scrolls', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 800 });
	await page.goto('/settings');
	await appReady(page);

	const viewport = page.getByTestId('tab-scroll-viewport');
	const firstLink = page
		.getByRole('navigation', { name: 'Settings sections' })
		.getByRole('link', { name: 'Theme', exact: true });
	const resting = (await firstLink.boundingBox())!.y;

	for (const top of [200, 600, 1500]) {
		await viewport.evaluate((node, to) => node.scrollTo(0, to), top);
		await expect
			.poll(async () => Math.round((await firstLink.boundingBox())!.y))
			.toBe(Math.round(resting));
	}
});

test('scrolling the last stretch visits About, Not available yet and Reset in order', async ({
	page
}) => {
	await page.goto('/settings');
	await appReady(page);

	const viewport = page.getByTestId('tab-scroll-viewport');
	const seen = await viewport.evaluate(async (node) => {
		const labels: string[] = [];
		const frames = async (count: number) => {
			for (let frame = 0; frame < count; frame += 1) {
				await new Promise((resolve) => requestAnimationFrame(resolve));
			}
		};

		// Wells resolve after paint and add height, so the foot is re-read at every step
		// and the walk only ends once it has rested there with the height unchanged.
		for (let top = 0; ; top += 20) {
			const max = node.scrollHeight - node.clientHeight;
			const at = Math.min(top, max);
			node.scrollTo(0, at);
			await frames(at === max ? 90 : 2);
			labels.push(document.querySelector('[aria-current="location"]')?.textContent?.trim() ?? '');
			if (at === max && node.scrollHeight - node.clientHeight === max) return labels;
		}
	});

	const tail = seen
		.filter((label) => ['About', 'Not available yet', 'Reset'].includes(label))
		.filter((label, position, labels) => position === 0 || labels[position - 1] !== label);

	expect(tail).toEqual(['About', 'Not available yet', 'Reset']);
});

test('clicking a section in the index selects it at the foot of the page', async ({ page }) => {
	await page.goto('/settings');
	await appReady(page);

	const index = page.getByRole('navigation', { name: 'Settings sections' });
	const link = (name: string) => index.getByRole('link', { name, exact: true });

	await link('About').click();
	await expect(link('About')).toHaveAttribute('aria-current', 'location');
	await expect(link('Reset')).not.toHaveAttribute('aria-current', 'location');

	await link('Reset').click();
	await expect(link('Reset')).toHaveAttribute('aria-current', 'location');

	await link('About').click();
	await expect(link('About')).toHaveAttribute('aria-current', 'location');
});

test('a failed preference save reports an error and restores the saved choice', async ({
	page
}) => {
	await page.goto('/settings');
	await appReady(page);
	const invalidTheme = await page.request.put('/api/settings', { data: { theme: 'sepia' } });
	expect(invalidTheme.status()).toBe(400);
	const combinedUpdate = await page.request.put('/api/settings', {
		data: { theme: 'dark', density: 'compact' }
	});
	expect(combinedUpdate.status()).toBe(400);
	await page.route('**/api/settings', async (route) => {
		if (route.request().method() === 'PUT') {
			await route.fulfill({ status: 503, body: 'Settings unavailable' });
			return;
		}
		await route.continue();
	});

	const failedSave = waitForSettingsSave(page);
	await option(page, 'Dark').click();
	expect((await failedSave).status()).toBe(503);
	await expect(page.getByRole('alert')).toContainText('Could not save settings');
	await expect(option(page, 'System')).toHaveAttribute('aria-checked', 'true');
});

test('open browsers receive shared preference changes and retry after polling failures', async ({
	page,
	browser
}) => {
	test.setTimeout(60_000);

	// The first propagation round rides the real poll window (35s = 30s ceiling +
	// margin) to keep the unfocused-staleness contract asserted. Later rounds
	// dispatch a synthetic visibilitychange so the poll's focus-resume handler
	// resets its backoff and polls immediately; otherwise the test accumulates
	// backoff tiers and outlives its budget.
	await page.goto('/settings');
	await appReady(page);
	const secondContext = await browser.newContext();

	try {
		const secondPage = await secondContext.newPage();
		await secondPage.goto('/settings');
		await appReady(secondPage);
		await expect(option(secondPage, 'Comfortable')).toHaveAttribute('aria-checked', 'true');

		const darkSave = waitForSettingsSave(page);
		await option(page, 'Dark').click();
		expect((await darkSave).ok()).toBeTruthy();
		await expect(option(secondPage, 'Dark')).toHaveAttribute('aria-checked', 'true', {
			timeout: 35000
		});
		await expect(secondPage.locator('html')).toHaveClass(/dark/);

		const compactSave = waitForSettingsSave(page);
		await option(page, 'Compact').click();
		expect((await compactSave).ok()).toBeTruthy();
		await dispatchVisibilityChange(secondPage);
		await expect(option(secondPage, 'Compact')).toHaveAttribute('aria-checked', 'true');
		await expect(secondPage.locator('html')).toHaveCSS('font-size', '15px');

		await secondContext.route('**/api/settings', async (route) => {
			if (route.request().method() === 'GET') {
				await route.fulfill({ status: 503, body: 'Settings unavailable' });
				return;
			}
			await route.continue();
		});
		await dispatchVisibilityChange(secondPage);
		await expect(secondPage.getByRole('status')).toContainText('out of date');
		await secondContext.unroute('**/api/settings');
		await dispatchVisibilityChange(secondPage);
		await expect(secondPage.getByRole('status')).toHaveCount(0);

		const saves = await Promise.all([
			page.request.put('/api/settings', { data: { theme: 'light' } }),
			secondContext.request.put('/api/settings', { data: { theme: 'dark' } })
		]);
		expect(saves.every((response) => response.ok())).toBe(true);
		const savedThemes = await Promise.all(
			saves.map(async (response) => {
				const body = (await response.json()) as { settings: { theme: string } };
				return body.settings.theme;
			})
		);
		expect(savedThemes.sort()).toEqual(['dark', 'light']);

		const current = await page.request.get('/api/settings');
		const currentSettings = (await current.json()) as { settings: { theme: string } };
		const selectedTheme = currentSettings.settings.theme === 'dark' ? 'Dark' : 'Light';
		await dispatchVisibilityChange(page);
		await dispatchVisibilityChange(secondPage);
		await expect(option(page, selectedTheme)).toHaveAttribute('aria-checked', 'true');
		await expect(option(secondPage, selectedTheme)).toHaveAttribute('aria-checked', 'true');
	} finally {
		await secondContext.close();
	}
});

test('Reduce motion freezes on reduce, animates on full, and paints before the app mounts', async ({
	page
}) => {
	await resetSettings(page);
	await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
	await page.goto('/settings');
	await appReady(page);

	// System follows this computer: the OS asks for less, so the index link does not ease.
	await expect(page.locator('html')).toHaveAttribute('data-motion', 'system');
	await expect.poll(() => transitionSeconds(page)).toBeLessThan(0.001);
	expect(await rootTransitionSeconds(page)).toBeLessThan(0.001);

	const fullSave = waitForSettingsSave(page);
	await pick(page, 'Reduce motion', 'Never reduce');
	expect((await fullSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
	await expect.poll(() => transitionSeconds(page)).toBeGreaterThan(0.1);
	expect(await rootTransitionSeconds(page)).toBeGreaterThan(0.1);

	// First paint reads the cache, before the settings effect can reconcile anything.
	await recordFirstPaint(page);
	await page.goto('/settings', { waitUntil: 'domcontentloaded' });
	expect(await readFirstPaint(page)).toMatchObject({ motion: 'full' });
	await appReady(page);
	await expect.poll(() => transitionSeconds(page)).toBeGreaterThan(0.1);

	// Always reduce freezes even when the computer does not ask to.
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	const reduceSave = waitForSettingsSave(page);
	await pick(page, 'Reduce motion', 'Always reduce');
	expect((await reduceSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
	await expect.poll(() => transitionSeconds(page)).toBeLessThan(0.001);
	expect(await rootTransitionSeconds(page)).toBeLessThan(0.001);

	await page.reload();
	await appReady(page);
	await expect(page.getByRole('button', { name: 'Reduce motion' })).toContainText('Always reduce');
	await expect.poll(() => transitionSeconds(page)).toBeLessThan(0.001);

	// Back to the shared default, where the OS preference applies again.
	const systemSave = waitForSettingsSave(page);
	await pick(page, 'Reduce motion', 'Follow this computer');
	expect((await systemSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveAttribute('data-motion', 'system');
	await expect.poll(() => transitionSeconds(page)).toBeGreaterThan(0.1);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect.poll(() => transitionSeconds(page)).toBeLessThan(0.001);
	expect(await rootTransitionSeconds(page)).toBeLessThan(0.001);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('Increase contrast strengthens rules and ink in both themes and paints before the app mounts', async ({
	page
}) => {
	await resetSettings(page);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/settings');
	await appReady(page);

	const textSizePicker = page.getByRole('button', { name: 'Text size' });
	await expect(page.locator('html')).not.toHaveAttribute('data-contrast');
	await expect(textSizePicker).toHaveCSS('border-top-color', 'rgb(128, 128, 128)');

	const onSave = waitForSettingsSave(page);
	await toggleSwitch(page, 'Increase contrast');
	expect((await onSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveAttribute('data-contrast', 'on');
	await expect.poll(() => rootVariable(page, '--rule-strong')).toBe('#5a5a5a');
	await expect.poll(() => rootVariable(page, '--ink-3')).toBe('#3d3d3d');
	await expect(textSizePicker).toHaveCSS('border-top-color', 'rgb(90, 90, 90)');

	await recordFirstPaint(page);
	await page.goto('/settings', { waitUntil: 'domcontentloaded' });
	expect(await readFirstPaint(page)).toMatchObject({ contrast: 'on' });
	await appReady(page);

	// The override follows the theme instead of pinning the light values.
	const darkSave = waitForSettingsSave(page);
	await option(page, 'Dark').click();
	expect((await darkSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveClass(/dark/);
	await expect.poll(() => rootVariable(page, '--rule-strong')).toBe('#a0a0a0');
	// Chromium serialises the custom property's repeated hex pair as #ccc.
	await expect.poll(() => rootVariable(page, '--ink-3')).toBe('#ccc');
	await expect(page.locator('html')).toHaveAttribute('data-contrast', 'on');

	const offSave = waitForSettingsSave(page);
	await toggleSwitch(page, 'Increase contrast');
	expect((await offSave).ok()).toBeTruthy();
	await expect(page.locator('html')).not.toHaveAttribute('data-contrast');
	await expect.poll(() => rootVariable(page, '--rule-strong')).toBe('#717171');

	const systemSave = waitForSettingsSave(page);
	await option(page, 'System').click();
	expect((await systemSave).ok()).toBeTruthy();
	await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('Text size multiplies Density on the root font size and paints before the app mounts', async ({
	page
}) => {
	await resetSettings(page);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/settings');
	await appReady(page);
	await expect(page.locator('html')).toHaveCSS('font-size', '16px');

	const stepSave = waitForSettingsSave(page);
	await pick(page, 'Text size', '125%');
	expect((await stepSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveAttribute('data-text-size', '125');
	await expect(page.locator('html')).toHaveCSS('font-size', '20px');
	await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCSS('font-size', '32.5px');

	await recordFirstPaint(page);
	await page.goto('/settings', { waitUntil: 'domcontentloaded' });
	expect(await readFirstPaint(page)).toMatchObject({ textSize: '125' });
	await appReady(page);
	await expect(page.locator('html')).toHaveCSS('font-size', '20px');

	// Density still multiplies rather than replaces it: Comfortable is 17px × 1.25.
	const comfortableSave = waitForSettingsSave(page);
	await option(page, 'Comfortable').click();
	expect((await comfortableSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveCSS('font-size', '21.25px');

	const standardSave = waitForSettingsSave(page);
	await option(page, 'Standard').click();
	expect((await standardSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveCSS('font-size', '20px');

	const resetTextSave = waitForSettingsSave(page);
	await pick(page, 'Text size', '100% (default)');
	expect((await resetTextSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveAttribute('data-text-size', '100');
	await expect(page.locator('html')).toHaveCSS('font-size', '16px');
});

test('Color-blind Assessment colors swap the tokens in both themes and paint before the app mounts', async ({
	page
}) => {
	await resetSettings(page);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/settings');
	await appReady(page);
	await expect(page.locator('html')).not.toHaveAttribute('data-assessment-palette');
	await expect.poll(() => rootVariable(page, '--assess-leader')).toBe('#00a461');

	const onSave = waitForSettingsSave(page);
	await toggleSwitch(page, 'Color-blind Assessment colors');
	expect((await onSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveAttribute('data-assessment-palette', 'colorblind');
	await expect.poll(() => rootVariable(page, '--assess-leader')).toBe('#104281');
	await expect.poll(() => rootVariable(page, '--assess-unassessed')).toBe('#6e7178');

	await recordFirstPaint(page);
	await page.goto('/settings', { waitUntil: 'domcontentloaded' });
	expect(await readFirstPaint(page)).toMatchObject({ palette: 'colorblind' });
	await appReady(page);

	const darkSave = waitForSettingsSave(page);
	await option(page, 'Dark').click();
	expect((await darkSave).ok()).toBeTruthy();
	await expect.poll(() => rootVariable(page, '--assess-leader')).toBe('#9ec5f4');
	await expect.poll(() => rootVariable(page, '--assess-disengaged')).toBe('#b0a294');
	await expect.poll(() => rootVariable(page, '--assess-unassessed')).toBe('#9aa3b0');

	const offSave = waitForSettingsSave(page);
	await toggleSwitch(page, 'Color-blind Assessment colors');
	expect((await offSave).ok()).toBeTruthy();
	await expect(page.locator('html')).not.toHaveAttribute('data-assessment-palette');
	await expect.poll(() => rootVariable(page, '--assess-leader')).toBe('#3be59d');

	const systemSave = waitForSettingsSave(page);
	await option(page, 'System').click();
	expect((await systemSave).ok()).toBeTruthy();
	await expect(page.locator('html')).not.toHaveClass(/dark/);
});

test('Date format and Time format shape the sample and a Note, and persist after reload', async ({
	page,
	request
}) => {
	await resetSettings(page);
	// A Note's stored time always carries a zone, so seed the instant that is 18:40 on
	// this computer; the browser reads it back in the same local time.
	const written = new Date(2026, 9, 19, 18, 40).toISOString();
	await createWorker(request, {
		name: 'Format Reader',
		attributes: await blankAttributes(request),
		notes: [{ id: 'note-format', text: 'A note with a set time.', timestamp: written }]
	});

	await page.goto('/settings');
	await appReady(page);
	const region = page.getByRole('region', { name: 'Language and region' });
	const sample = region.locator('[aria-live="polite"]');

	// Day-month-year, then ISO. The clock is still the computer's own format here.
	const dmySave = waitForSettingsSave(page);
	await pick(page, 'Date format', '19 Oct 2026');
	expect((await dmySave).ok()).toBeTruthy();
	await expect(sample).toContainText(/\d{1,2} [A-Z][a-z]{2} \d{4}, /);

	const isoSave = waitForSettingsSave(page);
	await pick(page, 'Date format', '2026-10-19');
	expect((await isoSave).ok()).toBeTruthy();
	await expect(sample).toContainText(/\d{4}-\d{2}-\d{2}, /);

	const twentyFourSave = waitForSettingsSave(page);
	await pick(page, 'Time format', '24-hour (14:30)');
	expect((await twentyFourSave).ok()).toBeTruthy();
	await expect(sample).toContainText(/\d{4}-\d{2}-\d{2}, \d{2}:\d{2}\.$/);

	const twelveSave = waitForSettingsSave(page);
	await pick(page, 'Time format', '12-hour (2:30 PM)');
	expect((await twelveSave).ok()).toBeTruthy();
	await expect(sample).toContainText(/\d{4}-\d{2}-\d{2}, \d{1,2}:\d{2} (AM|PM)\.$/);

	// Both choices are saved, so a reload reads them back and the sample keeps its shape.
	await page.reload();
	await appReady(page);
	await expect(page.getByRole('button', { name: 'Date format' })).toContainText('2026-10-19');
	await expect(page.getByRole('button', { name: 'Time format' })).toContainText(
		'12-hour (2:30 PM)'
	);
	await expect(sample).toContainText(/\d{4}-\d{2}-\d{2}, \d{1,2}:\d{2} (AM|PM)\.$/);

	// The Note seeded at 18:40 local reads in ISO date and 24-hour time, in the text
	// and in the controls that name it.
	const backTo24 = waitForSettingsSave(page);
	await pick(page, 'Time format', '24-hour (14:30)');
	expect((await backTo24).ok()).toBeTruthy();

	await page.goto('/workers');
	await appReady(page);
	await page
		.getByRole('row', { name: /Format Reader/ })
		.getByRole('gridcell', { name: 'Name for Format Reader: Format Reader', exact: true })
		.click();
	const record = page.getByRole('complementary', { name: 'Worker details: Format Reader' });
	await expect(record).toContainText('Written 2026-10-19, 18:40');
	await expect(
		record.getByRole('button', { name: 'Edit note from 2026-10-19, 18:40' })
	).toBeVisible();

	// Leave the registry as the last test expects to find it.
	await resetSettings(page);
});

test('window controls are hidden in the browser dev shim', async ({ page }) => {
	await page.goto('/settings');
	await appReady(page);

	const windowWell = page.getByRole('region', { name: 'Startup and window' });
	await expect(windowWell).toContainText('Window settings are available in the desktop app.');
	await expect(
		windowWell.getByRole('switch', { name: 'Remember window size and position' })
	).toHaveCount(0);
	await expect(windowWell.getByRole('button', { name: 'Reset window' })).toHaveCount(0);
});

test('resetting settings restores the defaults, rewrites the cache and keeps the data', async ({
	page,
	request,
	activeWorksite
}) => {
	// This is the settings suite's last test, so it also restores the defaults the suite
	// must leave behind.
	await createWorker(request, {
		name: 'Reset Survivor',
		attributes: await blankAttributes(request)
	});

	// Start from a known baseline: earlier tests leave a theme and density behind, and a
	// choice that is already selected would not save.
	expect((await request.delete('/api/settings')).ok()).toBeTruthy();
	await page.goto('/settings');
	await appReady(page);
	await expect(option(page, 'System')).toHaveAttribute('aria-checked', 'true');
	await expect(option(page, 'Standard')).toHaveAttribute('aria-checked', 'true');

	const darkSave = waitForSettingsSave(page);
	await option(page, 'Dark').click();
	expect((await darkSave).ok()).toBeTruthy();
	const comfortableSave = waitForSettingsSave(page);
	await option(page, 'Comfortable').click();
	expect((await comfortableSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveClass(/dark/);
	await expect(page.locator('html')).toHaveCSS('font-size', '17px');

	// Language is a saved setting too, so Reset must return it to following the computer.
	const languageSave = waitForSettingsSave(page);
	await pick(page, 'Language', 'Español (Latinoamérica)');
	expect((await languageSave).ok()).toBeTruthy();

	await page.getByRole('button', { name: 'Reset settings…' }).click();
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible();

	const resetDone = waitForSettingsReset(page);
	await dialog.getByRole('button', { name: 'Reset settings', exact: true }).click();
	expect((await resetDone).ok()).toBeTruthy();

	await expect(option(page, 'System')).toHaveAttribute('aria-checked', 'true');
	await expect(option(page, 'Standard')).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('html')).not.toHaveClass(/dark/);
	await expect(page.locator('html')).toHaveCSS('font-size', '16px');

	const resetRegistry = (await (await request.get('/api/settings')).json()) as {
		settings: { language: string };
	};
	expect(resetRegistry.settings.language).toBe('system');

	// Reset rewrites the first-paint cache, so the next paint is the default too.
	await expect
		.poll(() =>
			page.evaluate(
				() => JSON.parse(localStorage.getItem('wobble.appearance') ?? 'null')?.theme as unknown
			)
		)
		.toBe('system');

	// Only settings rows are deleted: the Active Worksite and its Workers stay.
	expect(await readStoredActiveWorksiteId(page)).toBe(activeWorksite.id);
	const dataset = await request.get('/api/dataset');
	const body = (await dataset.json()) as { workers: { name: string }[] };
	expect(body.workers.map((worker) => worker.name)).toContain('Reset Survivor');

	await page.reload();
	await appReady(page);
	await expect(option(page, 'System')).toHaveAttribute('aria-checked', 'true');
	await expect(option(page, 'Standard')).toHaveAttribute('aria-checked', 'true');
	await expect(page.locator('html')).not.toHaveClass(/dark/);
});

/*
 * The data controls run after the reset test because Restore replaces the database and
 * Erase empties it. Both act on the command's own WOBBLE_E2E_DB and nothing else.
 */

test('the Data row shows the real database path and hides Show in folder in the shim', async ({
	page,
	request
}) => {
	const configured = databasePath();

	await page.goto('/settings');
	await appReady(page);

	const dataWell = page.getByRole('region', { name: 'Data' });
	await expect(dataWell.locator('code')).toHaveText(configured);

	// The core answers with an absolute canonical path to the database it opened.
	const dataFile = (await (await request.get('/api/data-file')).json()) as { path: string };
	expect(dataFile.path).toBe(configured);

	// Show in folder is a desktop-shell action; the shim never renders it. The old fake
	// size line is gone too.
	await expect(dataWell.getByRole('button', { name: 'Show in folder' })).toHaveCount(0);
	await expect(dataWell).not.toContainText('4.2 MB');
});

test('Restore swaps in a v12 backup, refuses a garbage file, and names the safety copy', async ({
	page,
	request
}) => {
	const database = databasePath();
	await page.goto('/settings');
	await appReady(page);

	// A file that is not SQLite is refused before the live database is touched.
	const garbage = join(tmpdir(), `wobble-e2e-restore-garbage-${process.pid}-${Date.now()}.sqlite`);
	tempSources.push(garbage);
	writeFileSync(garbage, 'this is not a sqlite database');
	const beforeGarbage = await (await request.get('/api/dataset')).json();
	const refused = await request.post('/api/restore', { data: { path: garbage, legacy: true } });
	expect(refused.status()).toBe(400);
	expect((await refused.json()).code).toBe('restore_legacy_required');
	expect(await (await request.get('/api/dataset')).json()).toEqual(beforeGarbage);

	// Copy the v12 fixture to a scratch path so the restore reads a file this test owns.
	const source = join(tmpdir(), `wobble-e2e-restore-${process.pid}-${Date.now()}.sqlite`);
	tempSources.push(source);
	copyFileSync(resolve('contract/fixtures/rust-v12.sqlite'), source);

	const restored = await request.post('/api/restore', { data: { path: source, legacy: true } });
	expect(restored.status()).toBe(200);
	const { safetyCopyPath } = (await restored.json()) as { safetyCopyPath: string };
	expect(safetyCopyPath.startsWith(`${database}.pre-restore-`)).toBe(true);
	expect(safetyCopyPath.endsWith('.sqlite')).toBe(true);
	expect(existsSync(safetyCopyPath)).toBe(true);

	// Reloading reads the fixture's Worksite and Workers through the ready core.
	await page.reload();
	await appReady(page);
	const worksite = (await (await request.get('/api/worksite')).json()) as {
		worksite: { name: string } | null;
	};
	expect(worksite.worksite?.name).toBe('My Worksite');

	await page.goto('/workers');
	await appReady(page);
	await expect(page.getByRole('row', { name: /Rosalind Franklin/ })).toBeVisible();
	await expect(page.getByRole('row', { name: /Max Planck/ })).toBeVisible();
});

/** Selects one Worker's row and opens its Record panel. */
async function selectWorker(page: Page, name: string): Promise<void> {
	await page
		.getByRole('row', { name: new RegExp(name) })
		.getByRole('gridcell', { name: 'Name for ' + name + ': ' + name, exact: true })
		.or(
			page
				.getByRole('row', { name: new RegExp(name) })
				.getByRole('cell', { name: 'Show details for ' + name, exact: true })
		)
		.click();
}

const workerPanel = (page: Page, name: string) =>
	page.getByRole('complementary', { name: 'Worker details: ' + name });

test('Restore upgrades a v20 backup, keeps every Attribute in its draft, and reopens ordinary edits', async ({
	page,
	request
}) => {
	const database = databasePath();
	await page.goto('/settings');
	await appReady(page);

	// Copy the committed v20 fixture to a scratch path so the restore reads a file this
	// test owns. Its two Workers hold ordinary Attribute values, and its two ordinary
	// Worker drafts hold a pending Email, a pending Note and one pending Shift.
	const source = join(tmpdir(), `wobble-e2e-restore-v20-${process.pid}-${Date.now()}.sqlite`);
	tempSources.push(source);
	copyFileSync(resolve('contract/fixtures/workplace-v20.sqlite'), source);

	const restored = await request.post('/api/restore', { data: { path: source, legacy: true } });
	expect(restored.status()).toBe(200);
	const { safetyCopyPath } = (await restored.json()) as { safetyCopyPath: string };
	expect(safetyCopyPath.startsWith(`${database}.pre-restore-`)).toBe(true);
	expect(existsSync(safetyCopyPath)).toBe(true);

	// The fixture carries defaults, so the suite still leaves default settings behind.
	const settings = (await (await request.get('/api/settings')).json()) as {
		settings: { theme: string };
	};
	expect(settings.settings.theme).toBe('system');

	// The upgraded draft still carries every ordinary Attribute in both halves. Shifts
	// was a legacy assignment Attribute, so v21 moved it and v22 flattened it back to an
	// ordinary Single-Select (one saved answer per Worker); its older draft addition is
	// replaced by the migrated saved value in both the update and the base. Neither half
	// is missing an Attribute, which is what stops an older snapshot clearing a migrated
	// value on recovery.
	const fixture = { 'x-wobble-worksite': 'worksite-fixture' };
	const draftBody = (await (
		await request.get('/api/worker-drafts/worker-rosalind', { headers: fixture })
	).json()) as {
		draft: {
			update: { email: string; attributes: Record<string, unknown>; pendingNote?: unknown };
			base: { attributes: Record<string, unknown> };
			pendingNote: { text: string };
		};
	};
	expect(draftBody.draft.base.attributes).toEqual({
		dept: 'sales',
		role: 'cashier',
		shift: 'days'
	});
	expect(draftBody.draft.update.attributes).toEqual({
		dept: 'sales',
		role: 'cashier',
		shift: 'days'
	});
	expect(draftBody.draft.update.email).toBe('rosalind@example.test');
	expect(draftBody.draft.pendingNote.text).toBe('half a note');

	await page.reload();
	await appReady(page);
	await page.goto('/workers');
	await appReady(page);
	await expect(page.getByRole('row', { name: /Rosalind Franklin/ })).toBeVisible();
	await expect(page.getByRole('row', { name: /Max Planck/ })).toBeVisible();

	// Rosalind's ordinary draft reopens its Email editor and its pending Note; the flattened
	// Shifts value is read as the migrated saved answer, not the retired draft choice.
	await selectWorker(page, 'Rosalind Franklin');
	const rosalind = workerPanel(page, 'Rosalind Franklin');
	await expect(rosalind.getByTestId('restored-draft')).toBeVisible();
	await expect(rosalind.getByLabel('Email')).toHaveValue('rosalind@example.test');
	await expect(rosalind.getByRole('textbox', { name: 'Note' })).toHaveValue('half a note');
	const attributes = rosalind.locator('section[aria-labelledby="record-attributes"]');
	const row = (name: string) => attributes.locator('dl > div').filter({ hasText: name });
	await expect(row('Department').locator('dd')).toContainText('Sales');
	await expect(row('Role').locator('dd')).toContainText('Cashier');
	await expect(row('Shifts').locator('dd')).toContainText('Days');
	// The converted Single-Select offers one answer; no pending Shift editor reopened.
	await expect(
		row('Shifts').getByRole('button', { name: 'Edit Shifts', exact: true })
	).toBeVisible();
	await expect(row('Shifts').getByRole('combobox', { name: 'Shifts' })).toHaveCount(0);

	// Saving the recovered personal edit leaves the migrated Attribute value alone.
	await rosalind.getByLabel('Email').press('Enter');
	await expect(page.getByTestId('status-line')).toContainText("Saved Rosalind Franklin's Email");
	const savedAttributes = async () =>
		(await (await request.get('/api/dataset', { headers: fixture })).json()) as {
			workers: { id: string; attributes: Record<string, string | string[]> }[];
			attributes: { id: string; kind: string }[];
		};
	const afterSave = await savedAttributes();
	expect(afterSave.workers.find((worker) => worker.id === 'worker-rosalind')!.attributes).toEqual({
		dept: 'sales',
		role: 'cashier',
		shift: 'days'
	});
	// The one stored answer made the converted Attribute Single-Select.
	expect(afterSave.attributes.find((attribute) => attribute.id === 'shift')?.kind).toBe('category');

	// Bo's draft had no base, which reopens nothing; the other Worker keeps its own
	// readings and the abandoned draft does not linger.
	await selectWorker(page, 'Max Planck');
	const bo = workerPanel(page, 'Max Planck');
	await expect(bo.getByTestId('restored-draft')).toHaveCount(0);
	await expect(
		bo
			.locator('section[aria-labelledby="record-attributes"] dl > div')
			.filter({ hasText: 'Department' })
			.locator('dd')
	).toContainText('No Department');
	await expect
		.poll(
			async () =>
				(
					(await (
						await request.get('/api/worker-drafts/worker-bo', { headers: fixture })
					).json()) as { draft: unknown }
				).draft
		)
		.toBeNull();
});

test('a v20 backup that fails conversion reports the real error and leaves the live data unchanged', async ({
	request
}) => {
	const database = databasePath();

	// The v20 restore above is live. Corrupt a copy's stored answer so the same conversion
	// must refuse it; writing the file is test-only tooling, not app behaviour.
	const source = join(
		tmpdir(),
		`wobble-e2e-restore-corrupt-v20-${process.pid}-${Date.now()}.sqlite`
	);
	tempSources.push(source);
	copyFileSync(resolve('contract/fixtures/workplace-v20.sqlite'), source);
	const corrupt = new DatabaseSync(source);
	corrupt
		.prepare(
			'UPDATE worker_attribute_values SET value = ? WHERE worker_id = ? AND attribute_id = ?'
		)
		.run(JSON.stringify('not-an-answer'), 'worker-rosalind', 'dept');
	corrupt.close();

	const liveDataset = async () => {
		const response = await request.get('/api/dataset', {
			headers: { 'x-wobble-worksite': 'worksite-fixture' }
		});
		expect(response.ok(), await response.text()).toBeTruthy();
		return await response.json();
	};
	const before = await liveDataset();

	const refused = await request.post('/api/restore', { data: { path: source, legacy: true } });
	expect(refused.status()).toBe(500);
	const body = (await refused.json()) as { code: string; message: string; recoveryPath: string };
	expect(body.code).toBe('restore_failed');
	expect(body.message).toContain('Invalid legacy answer stored for worker worker-rosalind');
	expect(body.recoveryPath.startsWith(`${database}.pre-restore-`)).toBe(true);
	expect(existsSync(body.recoveryPath)).toBe(true);

	// The live database still answers with the same rows: the failed conversion never
	// swapped the backup in.
	expect(await liveDataset()).toEqual(before);
	const dataFile = (await (await request.get('/api/data-file')).json()) as { path: string };
	expect(dataFile.path).toBe(database);
});

test('Erase wipes every Worksite, clears the Active Worksite and names the safety copy', async ({
	page,
	context,
	request
}) => {
	const database = databasePath();
	await page.goto('/settings');
	await appReady(page);
	// Erase keeps installation Settings; the running session stays English either way.
	expect(
		(await page.request.put('/api/settings', { data: { language: 'es-419' } })).ok()
	).toBeTruthy();

	const erasing = page.waitForResponse(
		(response) => response.url().endsWith('/api/erase') && response.request().method() === 'POST'
	);
	await page.getByRole('button', { name: 'Erase all data…' }).click();
	const dialog = page.getByRole('alertdialog');
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Wobble saves a safety copy beside the database');
	await expect(dialog).toContainText('Settings are kept.');
	await expect(dialog).toContainText('Earlier backups and exports are not removed.');

	// The core requires exactly 'erase', so a capitalised word must not arm the action.
	const eraseAction = dialog.getByRole('button', { name: 'Erase everything' });
	await expect(eraseAction).toBeDisabled();
	await dialog.getByLabel(/Type erase to confirm/i).fill('Erase');
	await expect(eraseAction).toBeDisabled();
	await dialog.getByLabel(/Type erase to confirm/i).fill('erase');
	await expect(eraseAction).toBeEnabled();
	await eraseAction.click();

	const response = await erasing;
	expect(response.status()).toBe(200);
	const { safetyCopyPath } = (await response.json()) as { safetyCopyPath: string };
	expect(safetyCopyPath.startsWith(`${database}.pre-erase-`)).toBe(true);
	expect(safetyCopyPath.endsWith('.sqlite')).toBe(true);
	expect(existsSync(safetyCopyPath)).toBe(true);

	// The dialog names the copy, and the action forgot the Active Worksite.
	await expect(dialog).toContainText(safetyCopyPath);
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.evaluate(() => {
		const write = navigator.clipboard.writeText.bind(navigator.clipboard);
		navigator.clipboard.writeText = async () => {
			navigator.clipboard.writeText = write;
			throw new Error('Clipboard refused');
		};
	});
	await dialog.getByRole('button', { name: 'Copy path' }).click();
	await expect(dialog.getByRole('alert')).toHaveText('Could not copy to the clipboard.');
	await dialog.getByRole('button', { name: 'Copy path' }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(safetyCopyPath);
	await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
	await expect.poll(() => readStoredActiveWorksiteId(page)).toBeNull();

	const reloaded = page.waitForEvent('load');
	await dialog.getByRole('button', { name: 'Reload' }).click();
	await reloaded;
	await appReady(page);

	// Nothing worksite-scoped remains; the settings registry and schema are kept.
	const worksite = (await (await request.get('/api/worksite')).json()) as {
		worksite: unknown;
	};
	expect(worksite.worksite).toBeNull();
	const dataset = (await (await request.get('/api/dataset')).json()) as {
		worksites: unknown[];
		workers: unknown[];
	};
	expect(dataset.worksites).toEqual([]);
	expect(dataset.workers).toEqual([]);
	const keptSettings = (await (await request.get('/api/settings')).json()) as {
		settings: { language: string };
	};
	expect(keptSettings.settings.language).toBe('es-419');

	// Leave the registry as the language tests below expect to find it.
	expect((await page.request.delete('/api/settings')).ok()).toBeTruthy();
});

test.describe('Language persistence and the applied session', () => {
	test.afterEach(async ({ page }) => {
		await page.request.delete('/api/settings');
	});

	test('saves a choice, explains the restart, and applies it on the next open', async ({
		page
	}) => {
		await page.goto('/settings');
		await appReady(page);
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');

		const save = waitForSettingsSave(page);
		await pick(page, 'Language', 'Español (Latinoamérica)');
		expect((await save).ok()).toBeTruthy();

		await expect(
			page.getByRole('status').filter({ hasText: 'Quit and reopen Wobble' })
		).toContainText('Español (Latinoamérica)');
		// The running session keeps its frozen language: no remount, no reload.
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

		await page.reload();
		await appReady(page);
		await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');
		await expect(page.getByRole('heading', { name: 'Ajustes', level: 1 })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Idioma' })).toContainText(
			'Español (Latinoamérica)'
		);
	});

	test('a saved language stays deferred through a worksite data refresh', async ({ page }) => {
		expect((await page.request.post('/api/worksite')).ok()).toBeTruthy();
		await page.goto('/settings');
		await appReady(page);
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');

		const save = waitForSettingsSave(page);
		await pick(page, 'Language', 'Español (Latinoamérica)');
		expect((await save).ok()).toBeTruthy();
		await page.getByRole('link', { name: 'Configuration', exact: true }).click();
		await page.getByRole('button', { name: 'Edit worksite name' }).click();
		await page.getByRole('textbox', { name: 'Worksite name' }).fill('Deferred language refresh');
		await page.getByRole('textbox', { name: 'Worksite name' }).press('Enter');
		await page.getByRole('button', { name: 'Save all', exact: true }).click();
		// Wait for the save/refresh in either language, then assert the frozen session.
		await expect(
			page.getByRole('status').filter({ hasText: /Changes saved|Cambios guardados/ })
		).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(
			page.getByRole('button', { name: 'Active Worksite: Deferred language refresh', exact: true })
		).toBeVisible();

		await page.reload();
		await appReady(page);
		await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');
	});

	test('returning to a preference that resolves to the applied locale clears the notice', async ({
		page
	}) => {
		await page.goto('/settings');
		await appReady(page);

		const toSpanish = waitForSettingsSave(page);
		await pick(page, 'Language', 'Español (Latinoamérica)');
		expect((await toSpanish).ok()).toBeTruthy();
		await expect(page.getByRole('status').filter({ hasText: 'Quit and reopen' })).toBeVisible();

		const backToEnglish = waitForSettingsSave(page);
		await pick(page, 'Language', 'English');
		expect((await backToEnglish).ok()).toBeTruthy();
		await expect(page.getByRole('status').filter({ hasText: 'Quit and reopen' })).toHaveCount(0);
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	});

	test('a failed save restores the confirmed choice and reports in the applied language', async ({
		page
	}) => {
		await page.goto('/settings');
		await appReady(page);

		const save = page.waitForResponse(
			(response) =>
				response.url().endsWith('/api/settings') && response.request().method() === 'PUT'
		);
		await page.route('**/api/settings', async (route) => {
			if (route.request().method() === 'PUT') {
				await route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ message: 'storage unavailable' })
				});
				return;
			}
			await route.continue();
		});
		await pick(page, 'Language', 'Español (Latinoamérica)');
		expect((await save).ok()).toBeFalsy();
		await page.unroute('**/api/settings');

		await expect(page.getByRole('alert')).toContainText(
			'Could not save settings. The last saved value has been restored.'
		);
		await expect(page.getByRole('button', { name: 'Language' })).toContainText(
			'Same as this computer'
		);
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	});
});

test.describe('explicit choices override the computer language', () => {
	test.afterEach(async ({ page }) => {
		await page.request.delete('/api/settings');
	});

	test.describe('on a Spanish computer', () => {
		test.use({ locale: 'es-MX' });

		test('explicit English survives a reopen and Reset returns to system', async ({ page }) => {
			await page.goto('/settings');
			await appReady(page);
			await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');

			const save = waitForSettingsSave(page);
			await pick(page, 'Idioma', 'English');
			expect((await save).ok()).toBeTruthy();

			await page.reload();
			await appReady(page);
			await expect(page.locator('html')).toHaveAttribute('lang', 'en');
			await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

			await page.request.delete('/api/settings');
			await page.reload();
			await appReady(page);
			await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');
		});
	});

	test.describe('on an English computer', () => {
		test.use({ locale: 'en-US' });

		test('explicit Spanish survives a reopen and Reset returns to system', async ({ page }) => {
			await page.goto('/settings');
			await appReady(page);

			const save = waitForSettingsSave(page);
			await pick(page, 'Language', 'Español (Latinoamérica)');
			expect((await save).ok()).toBeTruthy();

			await page.reload();
			await appReady(page);
			await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');

			await page.request.delete('/api/settings');
			await page.reload();
			await appReady(page);
			await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		});
	});
});

test.describe('Spanish Settings', () => {
	test.use({ locale: 'es-MX' });

	test.afterEach(async ({ page }) => {
		await page.request.delete('/api/settings');
	});

	test('shows Spanish sections, options and a live date sample, and saves a choice', async ({
		page
	}) => {
		expect((await page.request.delete('/api/settings')).ok()).toBeTruthy();
		await page.goto('/settings');
		await appReady(page);

		await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');
		await expect(page.getByRole('heading', { name: 'Ajustes', level: 1 })).toBeVisible();
		const index = page.getByRole('navigation', { name: 'Secciones de Ajustes' });
		await expect(index.getByRole('link', { name: 'Tema', exact: true })).toBeVisible();
		await expect(page.getByRole('region', { name: 'Tema' })).toContainText(
			'Elige cómo se ve Wobble.'
		);
		await expect(page.getByRole('region', { name: 'Accesibilidad' })).toContainText(
			'Reducir movimiento'
		);
		await expect(page.getByRole('region', { name: 'Respaldos' })).toContainText(
			'Restaurar un respaldo requiere la aplicación de escritorio.'
		);

		// A live choice still reaches the registry and the root appearance attribute.
		const themeSave = waitForSettingsSave(page);
		await page.getByRole('radio', { name: 'Oscuro' }).click();
		expect((await themeSave).ok()).toBeTruthy();
		await expect(page.locator('html')).toHaveClass(/dark/);

		// The sample is one complete Spanish sentence around the formatted timestamp.
		const region = page.getByRole('region', { name: 'Idioma y región' });
		await expect(region).toContainText('Una nota escrita ahora se leería así:');
		const dateSave = waitForSettingsSave(page);
		await pick(page, 'Formato de fecha', '2026-10-19');
		expect((await dateSave).ok()).toBeTruthy();
		await expect(region).toContainText(/\d{4}-\d{2}-\d{2}/);
	});
});

test('@product-gap-16 shows the live database file size and latest write', async ({
	page,
	request
}) => {
	await page.goto('/settings');
	await appReady(page);

	const path = databasePath();
	const size = page.locator('[data-db-size-bytes]');
	const modified = page.locator('[data-db-modified-at]');

	await expect(size).toBeVisible();
	await expect(size).not.toHaveText('Unavailable');
	await expect
		.poll(async () => Number(await size.getAttribute('data-db-size-bytes')))
		.toBe(statSync(path).size);

	// The latest write across the main file and its WAL, not a sample value.
	await expect(modified).not.toHaveText('Unavailable');
	const shown = Date.parse((await modified.getAttribute('data-db-modified-at')) ?? '');
	expect(Number.isNaN(shown)).toBe(false);
	const walPath = path + '-wal';
	const latest = Math.max(
		statSync(path).mtimeMs,
		existsSync(walPath) ? statSync(walPath).mtimeMs : 0
	);
	expect(Math.abs(shown - latest)).toBeLessThan(10_000);

	// A later write is visible when the page next reads the file.
	await createWorker(request, {
		name: 'Metadata worker',
		attributes: await blankAttributes(request)
	});
	await page.reload();
	await appReady(page);
	const refreshed = Date.parse(
		(await page.locator('[data-db-modified-at]').getAttribute('data-db-modified-at')) ?? ''
	);
	expect(refreshed).toBeGreaterThanOrEqual(shown);
	expect(
		Number(await page.locator('[data-db-size-bytes]').getAttribute('data-db-size-bytes'))
	).toBeGreaterThan(0);
});

test('@product-gap-15 shows and copies the running installation details', async ({
	page,
	request,
	context
}) => {
	const answered = await request.get('/api/runtime');
	expect(answered.ok(), await answered.text()).toBeTruthy();
	const runtime = (await answered.json()) as {
		appVersion: string;
		build: string;
		platform: string;
		schemaVersion: number;
	};

	await page.goto('/settings');
	// The shared machine can be heavily loaded; give hydration longer than the default.
	await expect(page.locator('#splash')).toHaveCount(0, { timeout: 20_000 });
	await appReady(page);

	const about = page.locator('#about');
	// The displayed values are the ones the running core reports, not samples.
	await expect(about).toContainText(runtime.appVersion);
	await expect(about).toContainText(runtime.build);
	await expect(about).toContainText(runtime.platform);
	await expect(about).toContainText(String(runtime.schemaVersion));
	await expect(about).not.toContainText('a1b2c3d');

	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await about.getByRole('button', { name: 'Copy details' }).click();
	await expect(about.getByRole('button', { name: 'Copied' })).toBeVisible();
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toContain(`Version: ${runtime.appVersion}`);
	expect(copied).toContain(`Database schema: ${runtime.schemaVersion}`);

	// The diagnostics action copies the same displayed details.
	const diagnostics = page.locator('#diagnostics');
	await diagnostics.getByRole('button', { name: 'Copy info' }).click();
	await expect(diagnostics.getByRole('button', { name: 'Copied' })).toBeVisible();
	const copiedInfo = await page.evaluate(() => navigator.clipboard.readText());
	expect(copiedInfo).toContain(`Platform: ${runtime.platform}`);
});

test('@product-gap-14 disables unfinished operations and leaves live settings working', async ({
	page
}) => {
	test.setTimeout(60_000);
	await page.goto('/settings');
	// This shared machine can be loaded; hydration sometimes needs longer than 5s.
	await expect(page.locator('#splash')).toHaveCount(0, { timeout: 20_000 });
	await appReady(page);

	// Working sections come first; the unavailable group is second-to-last, Reset last,
	// and the group is collapsed with one line per feature and no controls.
	const sectionIds = await page
		.locator('[data-well]')
		.evaluateAll((nodes) => nodes.map((n) => n.id));
	expect(sectionIds.slice(0, 3)).toEqual(['data', 'backups', 'privacy']);
	expect(sectionIds.slice(-2)).toEqual(['unavailable', 'reset']);
	await expect(page.locator('#unavailable details')).not.toHaveAttribute('open', '');
	await expect(page.locator('#unavailable button, #unavailable input')).toHaveCount(0);
	for (const row of ['upd', 'bak-auto', 'prv-lock', 'dx-logs', 'about-licences']) {
		await expect(settingsRow(page, row)).toHaveAttribute('data-unavailable', 'true');
	}
	for (const name of [
		'Check for updates',
		'Back up automatically',
		'Automatic locking',
		'Open log folder',
		'Open-source licences'
	]) {
		await expect(page.getByRole('button', { name })).toHaveCount(0);
		await expect(page.getByRole('switch', { name })).toHaveCount(0);
	}

	// Protection is accurate and working: encryption status and Change passphrase.
	await expect(settingsRow(page, 'prv-encryption')).toContainText('are encrypted');
	await expect(
		settingsRow(page, 'prv-change').getByRole('button', { name: 'Change passphrase', exact: true })
	).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Copy info' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Copy details' })).toBeEnabled();

	// Language is live now that the locale session exists: it is not an unfinished operation.
	await expect(page.getByRole('button', { name: 'Language' })).toBeEnabled();

	// The live controls still save: Theme goes through the real PUT, then back to default.
	const darkSave = waitForSettingsSave(page);
	await option(page, 'Dark').click();
	expect((await darkSave).ok()).toBeTruthy();
	await expect(page.locator('html')).toHaveClass(/dark/);

	const systemSave = waitForSettingsSave(page);
	await option(page, 'System').click();
	expect((await systemSave).ok()).toBeTruthy();
	await expect(page.locator('html')).not.toHaveClass(/dark/);

	await expect(page.getByRole('button', { name: 'Date format' })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Copy path' })).toBeEnabled();
});

test('encrypted export, guarded passphrase change and source-key restore preserve the installation key', async ({
	page,
	request,
	context
}) => {
	const exported = join(tmpdir(), `wobble-e2e-encrypted-${process.pid}-${Date.now()}.sqlite`);
	tempSources.push(exported);
	const nextPassphrase = 'New isolated Settings fixture credential';
	const before = await (await request.get('/api/dataset')).json();
	const backup = await request.post('/api/backup', { data: { path: exported } });
	expect(backup.status()).toBe(200);
	expect(readFileSync(exported).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
	expect(await (await request.get('/api/dataset')).json()).toEqual(before);
	let release: () => void = () => {};
	const released = new Promise<void>((done) => {
		release = done;
	});
	let responseStatus = 0;
	let credentialRestored = false;
	await page.route('**/api/boot-change-passphrase', async (route) => {
		const upstream = await route.fetch();
		responseStatus = upstream.status();
		await released;
		await route.fulfill({ response: upstream });
	});
	try {
		await page.goto('/settings');
		await appReady(page);
		await expect(settingsRow(page, 'prv-encryption')).toContainText('are encrypted');
		await settingsRow(page, 'prv-change')
			.getByRole('button', { name: 'Change passphrase', exact: true })
			.click();
		const dialog = page.getByRole('dialog', { name: 'Change passphrase' });
		await dialog.getByLabel('Current passphrase', { exact: true }).fill(TEST_PASSPHRASE);
		await dialog.getByLabel('New passphrase', { exact: true }).fill(nextPassphrase);
		await dialog.getByLabel('Confirm new passphrase', { exact: true }).fill(nextPassphrase);
		await dialog.getByRole('button', { name: 'Change passphrase', exact: true }).click();
		await expect.poll(() => responseStatus).toBe(200);
		await expect(dialog.getByLabel('Current passphrase', { exact: true })).toHaveValue('');
		await expect(dialog.getByLabel('New passphrase', { exact: true })).toHaveValue('');
		await expect(dialog.getByLabel('Confirm new passphrase', { exact: true })).toHaveValue('');
		await page.keyboard.press('Escape');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
		release();
		await expect(dialog.getByRole('status')).toHaveText('Passphrase changed.');
		await expect(dialog).toContainText('This recovery copy uses your previous passphrase.');
		const recovery = (await dialog.locator('code[data-selectable]').textContent())!;
		expect(existsSync(recovery)).toBe(true);
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await dialog.getByRole('button', { name: 'Copy path', exact: true }).click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(recovery);
		const wrong = await request.post('/api/restore', {
			data: { path: recovery, sourcePassphrase: nextPassphrase }
		});
		expect(wrong.status()).toBe(401);
		expect(await (await request.get('/api/dataset')).json()).toEqual(before);
		const fromRecovery = await request.post('/api/restore', {
			data: { path: recovery, sourcePassphrase: TEST_PASSPHRASE }
		});
		expect(fromRecovery.status()).toBe(200);
		const exportedHash = readFileSync(exported);
		const fromExport = await request.post('/api/restore', {
			data: { path: exported, sourcePassphrase: TEST_PASSPHRASE }
		});
		expect(fromExport.status()).toBe(200);
		expect(readFileSync(exported)).toEqual(exportedHash);
		expect(await (await request.get('/api/dataset')).json()).toEqual(before);
		// Restores must keep the installation credential, regardless of the source key.
		const reset = await request.post('/api/boot-change-passphrase', {
			data: { current: nextPassphrase, next: TEST_PASSPHRASE, confirm: TEST_PASSPHRASE }
		});
		expect(reset.status()).toBe(200);
		credentialRestored = true;
	} finally {
		release();
		await page.unroute('**/api/boot-change-passphrase');
		if (!credentialRestored) {
			const reset = await request.post('/api/boot-change-passphrase', {
				data: { current: nextPassphrase, next: TEST_PASSPHRASE, confirm: TEST_PASSPHRASE }
			});
			// Cleanup after a failure before rotation may find the original credential.
			expect([200, 401]).toContain(reset.status());
		}
	}
});

test('pre-erase recovery is encrypted and restores the complete prior dataset', async ({
	request
}) => {
	const before = await (await request.get('/api/dataset')).json();
	const erased = await request.post('/api/erase', { data: { confirm: 'erase' } });
	expect(erased.status()).toBe(200);
	const { safetyCopyPath } = await erased.json();
	expect(readFileSync(safetyCopyPath).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
	const wrong = await request.post('/api/restore', {
		data: { path: safetyCopyPath, sourcePassphrase: 'wrong isolated credential' }
	});
	expect(wrong.status()).toBe(401);
	expect((await (await request.get('/api/dataset')).json()).worksites).toEqual([]);
	const restored = await request.post('/api/restore', {
		data: { path: safetyCopyPath, sourcePassphrase: TEST_PASSPHRASE }
	});
	expect(restored.status()).toBe(200);
	expect(await (await request.get('/api/dataset')).json()).toEqual(before);
});

test('search narrows the index and Enter jumps to the first match', async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 800 });
	await page.goto('/settings');
	await appReady(page);

	const index = page.getByRole('navigation', { name: 'Settings sections' });
	const search = page.getByRole('searchbox', { name: 'Search settings' });

	await search.fill('passphrase');
	await expect(index.getByRole('link')).toHaveText(['Privacy']);

	await search.fill('licences');
	await expect(index.getByRole('link')).toHaveText(['Not available yet']);
	await search.press('Enter');
	await expect(page.locator('#unavailable details')).toHaveAttribute('open', '');
	await expect(index.getByRole('link', { name: 'Not available yet' })).toHaveAttribute(
		'aria-current',
		'location'
	);

	await search.fill('zzzz');
	await expect(index.getByRole('link')).toHaveCount(0);
	await search.press('Escape');
	await expect(index.getByRole('link')).toHaveCount(13);
});
