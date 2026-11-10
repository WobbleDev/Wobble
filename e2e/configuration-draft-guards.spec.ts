import { expect, test } from './fixtures.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import type { Page } from '@playwright/test';

/**
 * The ways out of a dirty Configuration draft. Every one of them asks the same
 * single prompt, and a Discard that navigates must not trip it a second time.
 */

async function makeDirty(page: Page) {
	await page.getByRole('button', { name: 'Edit worksite name' }).click();
	await page.getByRole('textbox', { name: 'Worksite name' }).fill('Unsaved Draft Name');
	await page.getByRole('textbox', { name: 'Worksite name' }).press('Enter');
	await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
}

const prompt = (page: Page) => page.getByRole('alertdialog');

/** Dispatches a cancelable unload event and reports whether the page asked to stay. */
function unloadWarned(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const event = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(event);
		return event.defaultPrevented;
	});
}

test('a clean Configuration leaves for a rail link with no prompt', async ({ page }) => {
	await openConfiguration(page);

	await page.getByRole('link', { name: 'Workers', exact: true }).click();

	await expect(page).toHaveURL('/workers');
	await expect(prompt(page)).toHaveCount(0);
});

test('a dirty Configuration holds a rail navigation until answered', async ({ page }) => {
	await openConfiguration(page);
	await makeDirty(page);

	// Any write while the draft is dirty would mean the draft left with the page.
	const writes: string[] = [];
	page.on('request', (request) => {
		// The Short form suggestions are a read, not a write.
		if (request.method() !== 'GET' && !request.url().endsWith('/api/configuration/short-forms')) {
			writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
		}
	});

	await page.getByRole('link', { name: 'Workers', exact: true }).click();

	await expect(prompt(page)).toContainText('Workers');
	await prompt(page).getByRole('button', { name: 'Keep editing' }).click();

	// Stay is a real stay: same URL, draft intact, nothing written.
	await expect(page).toHaveURL('/configuration');
	await expect(page.getByRole('button', { name: 'Edit worksite name' })).toContainText(
		'Unsaved Draft Name'
	);
	await expect(page.getByText('Unsaved Draft Name')).toBeVisible();
	expect(writes).toEqual([]);

	// Asked again rather than remembered, and Discard leaves without writing.
	await page.getByRole('link', { name: 'Workers', exact: true }).click();
	await prompt(page).getByRole('button', { name: 'Discard and leave' }).click();

	await expect(page).toHaveURL('/workers');
	expect(writes).toEqual([]);
	await expect(page.getByText('Unsaved Draft Name')).toHaveCount(0);
});

test('the breadcrumb out of Configuration is held too', async ({ page, activeWorksite }) => {
	await openConfiguration(page);
	await makeDirty(page);

	await page.getByRole('link', { name: activeWorksite.name, exact: true }).click();

	await expect(prompt(page)).toContainText('Overview');
	await prompt(page).getByRole('button', { name: 'Discard and leave' }).click();

	await expect(page).toHaveURL('/overview');
});

test('browser Back is held, and a Discard resumes once with no second prompt', async ({ page }) => {
	// Arrive by a client-side link, so Back is a history pop SvelteKit owns rather
	// than a full document load, which only the unload warning can speak to.
	await page.goto('/workers');
	await appReady(page);
	await page.getByRole('link', { name: 'Configuration', exact: true }).click();
	await expect(page).toHaveURL('/configuration');
	await makeDirty(page);

	// history.back() rather than page.goBack(): the navigation is cancelled, so
	// there is nothing for Playwright to settle on.
	await page.evaluate(() => history.back());

	await expect(prompt(page)).toContainText('Workers');
	await prompt(page).getByRole('button', { name: 'Discard and leave' }).click();

	// One prompt, one navigation: the release must not raise the dialog again.
	await expect(page).toHaveURL('/workers');
	await expect(prompt(page)).toHaveCount(0);
});

test('an unload warning is registered only while the draft is dirty', async ({ page }) => {
	await openConfiguration(page);
	expect(await unloadWarned(page)).toBe(false);

	await makeDirty(page);
	expect(await unloadWarned(page)).toBe(true);

	// Discarding from the save bar clears the draft, so the warning goes with it.
	await page.getByRole('button', { name: 'Discard', exact: true }).click();
	await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
	await expect.poll(() => unloadWarned(page)).toBe(false);
});

test('saving a draft clears the warning without a prompt', async ({ page }) => {
	await openConfiguration(page);
	await makeDirty(page);
	expect(await unloadWarned(page)).toBe(true);

	await page.getByRole('button', { name: 'Save all' }).click();
	await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0);

	await expect.poll(() => unloadWarned(page)).toBe(false);

	// A saved Configuration leaves freely.
	await page.getByRole('link', { name: 'Workers', exact: true }).click();
	await expect(page).toHaveURL('/workers');
	await expect(prompt(page)).toHaveCount(0);
});

/** The native quit request, as the browser transport lets a spec fire it. */
const requestQuit = (page: Page) =>
	page.evaluate(() => window.dispatchEvent(new Event('wobble:quit-requested')));

/** Counts the exit requests the page makes where the desktop shell would quit. */
async function countExits(page: Page) {
	await page.evaluate(() => {
		const w = window as unknown as { __exits: number };
		w.__exits = 0;
		window.addEventListener('wobble:exit-requested', () => w.__exits++);
	});
	return () => page.evaluate(() => (window as unknown as { __exits: number }).__exits);
}

test('a clean quit request exits at once', async ({ page }) => {
	await openConfiguration(page);
	const exits = await countExits(page);

	await requestQuit(page);

	await expect.poll(exits).toBe(1);
	await expect(prompt(page)).toHaveCount(0);
});

test('a dirty quit request asks, Stay keeps the draft, Discard exits', async ({ page }) => {
	await openConfiguration(page);
	await makeDirty(page);
	const exits = await countExits(page);

	await requestQuit(page);
	await expect(prompt(page)).toContainText('Quit Wobble?');
	await prompt(page).getByRole('button', { name: 'Keep editing' }).click();

	await expect(prompt(page)).toHaveCount(0);
	expect(await exits()).toBe(0);
	await expect(page.getByText('Unsaved Draft Name')).toBeVisible();

	await requestQuit(page);
	await prompt(page).getByRole('button', { name: 'Discard and quit' }).click();
	await expect.poll(exits).toBe(1);
});
