import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures.ts';
import type { APIRequestContext, Page } from '@playwright/test';
import { answerId, wireDefinitions } from './answer-wire.ts';

/**
 * Ticket 23 — the record panel's unsaved typing survives a quit (ADR-0023).
 *
 * Typing into an open editor is autosaved to the core about a second after the
 * last keystroke, reopens that editor after a reload, and is forgotten once the
 * work lands or the organizer discards it. The Worker dialog no longer keeps a
 * draft, so the panel is the only writer of this key.
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** The id of the imported Worker with this name. */
async function workerId(request: APIRequestContext, name: string): Promise<string> {
	const body = (await (await request.get('/api/dataset')).json()) as {
		workers: { id: string; name: string }[];
	};
	const worker = body.workers.find((candidate) => candidate.name === name);
	if (!worker) throw new Error(`No Worker named ${name}.`);
	return worker.id;
}

const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });
const select = (page: Page, name: string) =>
	row(page, name)
		.getByRole('gridcell', { name: `Name for ${name}: ${name}`, exact: true })
		// The grid role is off below the desktop rail, leaving plain cells.
		.or(row(page, name).getByRole('cell', { name: `Show details for ${name}`, exact: true }))
		.click();
const panel = (page: Page, name: string) =>
	page.getByRole('complementary', { name: `Worker details: ${name}` });
const storedDraft = async (request: APIRequestContext, id: string) =>
	((await (await request.get(`/api/worker-drafts/${id}`)).json()) as { draft: unknown }).draft;

/** The Workers, with their stored attributes, as the record row reads them. */
async function storedWorkers(request: APIRequestContext): Promise<
	{
		id: string;
		name: string;
		attributes: Record<string, string | string[]>;
	}[]
> {
	const body = (await (await request.get('/api/dataset')).json()) as {
		workers: { id: string; name: string; attributes: Record<string, string | string[]> }[];
	};
	return body.workers;
}

/** The two Workers these tests work with, and their ids. */
async function seed(request: APIRequestContext): Promise<{ draftKeeper: string; other: string }> {
	await request.post('/api/workers', {
		data: [{ name: 'Draft Keeper' }, { name: 'Other Worker' }]
	});

	return {
		draftKeeper: await workerId(request, 'Draft Keeper'),
		other: await workerId(request, 'Other Worker')
	};
}

async function openWorkers(page: Page) {
	await page.goto('/workers');
	await expect(row(page, 'Draft Keeper')).toBeVisible();
}

/** Selects Draft Keeper and leaves a typed Email open in the panel, uncommitted. */
async function typeEmail(page: Page, email: string) {
	await select(page, 'Draft Keeper');
	const keeper = panel(page, 'Draft Keeper');
	await keeper.getByRole('button', { name: 'Edit email' }).click();
	await keeper.getByLabel('Email').fill(email);
}

/** The autosave writes about a second after the last keystroke; wait for the write itself. */
async function waitForDraft(request: APIRequestContext, id: string) {
	await expect.poll(() => storedDraft(request, id)).not.toBeNull();
}

test('typed Email survives a reload and reopens with the message', async ({ page, request }) => {
	const { draftKeeper } = await seed(request);
	await openWorkers(page);

	await typeEmail(page, 'draft@example.test');
	await waitForDraft(request, draftKeeper);
	await page.reload();
	await select(page, 'Draft Keeper');

	// The record shows at once; the stored draft arrives a moment later and reopens the editor.
	await expect(page.getByTestId('restored-draft')).toContainText('Restored unsaved changes from');
	const keeper = panel(page, 'Draft Keeper');
	await expect(keeper.getByLabel('Email')).toHaveValue('draft@example.test');
});

/** A Worksite with both ordinary Attribute kinds, and one Worker holding several values. */
async function seedAttributes(request: APIRequestContext) {
	const departmentId = randomUUID();
	const shiftsId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: shiftsId, name: 'Shifts', kind: 'tag', options: ['Dinner', 'Brunch'] }
		])
	});
	expect(configured.status(), await configured.text()).toBe(200);

	const created = await request.post('/api/workers', {
		data: [{ name: 'Draft Keeper' }, { name: 'Other Worker' }, { name: 'No Values' }]
	});
	expect(created.ok(), await created.text()).toBeTruthy();
	const draftKeeper = await workerId(request, 'Draft Keeper');
	const other = await workerId(request, 'Other Worker');
	const empty = await workerId(request, 'No Values');

	const held = await request.patch(`/api/workers/${draftKeeper}`, {
		data: {
			attributeId: departmentId,
			value: answerId(departmentId, 'Front of House')
		}
	});
	expect(held.ok(), await held.text()).toBeTruthy();
	const several = await request.patch(`/api/workers/${draftKeeper}`, {
		data: {
			attributeId: shiftsId,
			value: [answerId(shiftsId, 'Dinner'), answerId(shiftsId, 'Brunch')]
		}
	});
	expect(several.ok(), await several.text()).toBeTruthy();

	return { draftKeeper, other, empty, departmentId, shiftsId };
}

test('an ordinary Email draft carries every Attribute, including several and none', async ({
	page,
	request
}) => {
	const { draftKeeper, departmentId, shiftsId } = await seedAttributes(request);
	const before = await storedWorkers(request);
	await openWorkers(page);

	const saved = page.waitForResponse(
		(response) =>
			response.url().includes('/api/worker-drafts/') && response.request().method() === 'PUT'
	);
	await typeEmail(page, 'ordinary-draft@example.test');
	expect((await saved).status()).toBe(200);

	const draft = (await storedDraft(request, draftKeeper)) as {
		update: { email: string; attributes: Record<string, string | string[]> };
		base: { email: string; attributes: Record<string, string | string[]> };
	};
	const keeper = before.find((worker) => worker.id === draftKeeper)!;
	// Both halves of the draft carry every configured Attribute, held or not.
	expect(draft.update.email).toBe('ordinary-draft@example.test');
	expect(draft.update.attributes).toEqual(keeper.attributes);
	expect(draft.base.email).toBe('');
	expect(draft.base.attributes).toEqual(keeper.attributes);
	expect(Object.keys(draft.update.attributes).sort()).toEqual([departmentId, shiftsId].sort());

	// The recovered record shows the personal edit and both Attribute readings, and
	// writing nothing back leaves the saved values where they were.
	await page.reload();
	await select(page, 'Draft Keeper');
	await expect(page.getByTestId('restored-draft')).toBeVisible();
	const panel = page.getByRole('complementary', { name: 'Worker details: Draft Keeper' });
	await expect(panel.getByLabel('Email')).toHaveValue('ordinary-draft@example.test');
	const attributes = panel.locator('section[aria-labelledby="record-attributes"]');
	const department = attributes.locator('dl > div').filter({ hasText: 'Department' });
	const shifts = attributes.locator('dl > div').filter({ hasText: 'Shifts' });
	await expect(department.locator('dd')).toContainText('Front of House');
	await expect(shifts.locator('dd')).toContainText('Dinner, Brunch');

	expect(await storedWorkers(request)).toEqual(before);
});

test('a recovered Attribute edit reopens with the draft choice and can be saved or left alone', async ({
	page,
	request
}) => {
	const { draftKeeper, departmentId } = await seedAttributes(request);
	await openWorkers(page);

	// An open Single-Select editor is unsaved input: the panel stores its choice.
	await select(page, 'Draft Keeper');
	const panel = page.getByRole('complementary', { name: 'Worker details: Draft Keeper' });
	const department = () =>
		panel
			.locator('section[aria-labelledby="record-attributes"] dl > div')
			.filter({ hasText: 'Department' });
	await department().getByRole('button', { name: 'Edit Department', exact: true }).click();
	await department()
		.getByRole('combobox', { name: 'Department' })
		.selectOption({ label: 'Back of House' });
	await waitForDraft(request, draftKeeper);
	const draft = (await storedDraft(request, draftKeeper)) as {
		update: { attributes: Record<string, string | string[]> };
	};

	// Reload: the editor reopens with the stored choice, without seizing focus.
	await page.reload();
	await select(page, 'Draft Keeper');
	await expect(page.getByTestId('restored-draft')).toBeVisible();
	const restored = panel.getByRole('combobox', { name: 'Department' });
	await expect(restored).toHaveValue(draft.update.attributes[departmentId] as string);
	await expect(restored).not.toBeFocused();
	await panel.getByRole('button', { name: 'Save', exact: true }).click();

	await expect(page.getByTestId('status-line')).toContainText("Saved Draft Keeper's Department");
	await expect(department().locator('dd')).toContainText('Back of House');
	await expect.poll(() => storedDraft(request, draftKeeper)).toBeNull();
	const after = await storedWorkers(request);
	expect(after.find((worker) => worker.id === draftKeeper)?.attributes[departmentId]).toBe(
		answerId(departmentId, 'Back of House')
	);
});

test('a draft that omits a configured Attribute is refused rather than clearing it', async ({
	request
}) => {
	const { draftKeeper, departmentId } = await seedAttributes(request);
	const before = await storedWorkers(request);
	const keeper = before.find((worker) => worker.id === draftKeeper)!;

	// An older snapshot that predates an Attribute cannot be stored at v22: the core
	// refuses it, so recovering one cannot clear the saved value behind the draft.
	const update = {
		name: 'Draft Keeper',
		email: '',
		phone: '',
		assessment: 'Unassessed',
		attributes: { [departmentId]: keeper.attributes[departmentId] },
		agitations: [],
		languages: [],
		relationships: [],
		notes: []
	};
	const refused = await request.put(`/api/worker-drafts/${draftKeeper}`, {
		data: { update, pendingNote: { text: '' }, base: null }
	});
	expect(refused.status()).toBe(400);
	expect(await refused.text()).toContain('valid Worker draft');

	expect(await storedDraft(request, draftKeeper)).toBeNull();
	expect(await storedWorkers(request)).toEqual(before);
});

test('a typed Note survives a reload', async ({ page, request }) => {
	const { draftKeeper } = await seed(request);
	await openWorkers(page);

	await select(page, 'Draft Keeper');
	const keeper = panel(page, 'Draft Keeper');
	await keeper.getByRole('textbox', { name: 'Note' }).fill('Half a note');

	await waitForDraft(request, draftKeeper);
	await page.reload();
	await select(page, 'Draft Keeper');

	const reopened = panel(page, 'Draft Keeper');
	await expect(reopened.getByRole('textbox', { name: 'Note' })).toHaveValue('Half a note');
});

test('committing the restored edit deletes the draft', async ({ page, request }) => {
	const { draftKeeper } = await seed(request);
	await openWorkers(page);

	await typeEmail(page, 'draft@example.test');
	await waitForDraft(request, draftKeeper);
	await page.reload();
	await select(page, 'Draft Keeper');

	await expect(page.getByTestId('restored-draft')).toBeVisible();
	const keeper = panel(page, 'Draft Keeper');
	await expect(keeper.getByLabel('Email')).toHaveValue('draft@example.test');
	await keeper.getByLabel('Email').press('Enter');

	await expect(page.getByTestId('status-line')).toContainText("Saved Draft Keeper's Email");
	await expect.poll(() => storedDraft(request, draftKeeper)).toBeNull();

	await page.reload();
	await select(page, 'Draft Keeper');
	await expect(page.getByTestId('restored-draft')).toHaveCount(0);
});

test('selecting and leaving a Worker without typing writes no draft', async ({ page, request }) => {
	const { draftKeeper } = await seed(request);
	await page.clock.install();
	await openWorkers(page);

	await select(page, 'Draft Keeper');
	await select(page, 'Other Worker');
	// A negative wait: sit past the autosave window to prove no draft appears.
	await page.clock.fastForward(1500);

	expect(await storedDraft(request, draftKeeper)).toBeNull();
});

test('Discard them forgets the draft and closes the editor', async ({ page, request }) => {
	const { draftKeeper } = await seed(request);
	await openWorkers(page);

	await typeEmail(page, 'draft@example.test');
	await waitForDraft(request, draftKeeper);
	await page.reload();
	await select(page, 'Draft Keeper');

	const keeper = panel(page, 'Draft Keeper');
	await expect(page.getByTestId('restored-draft')).toContainText('Restored unsaved changes from');
	await page.getByTestId('restored-draft').getByRole('button', { name: 'Discard them' }).click();

	await expect(page.getByTestId('restored-draft')).toHaveCount(0);
	// The closed field is still labelled "Edit email", and getByLabel matches
	// substrings, so the input itself is what proves the editor is closed.
	await expect(keeper.getByRole('textbox', { name: 'Email' })).toHaveCount(0);
	await expect.poll(() => storedDraft(request, draftKeeper)).toBeNull();

	const stored = (await (await request.get('/api/dataset')).json()) as {
		workers: { id: string; email: string }[];
	};
	expect(stored.workers.find((candidate) => candidate.id === draftKeeper)?.email).toBe('');
});

test('hiding the page stores a pending draft before the autosave timer fires', async ({
	page,
	request
}) => {
	const { draftKeeper } = await seed(request);
	await openWorkers(page);

	await typeEmail(page, 'hidden@example.test');
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
		document.dispatchEvent(new Event('visibilitychange'));
	});

	await expect.poll(() => storedDraft(request, draftKeeper), { timeout: 800 }).not.toBeNull();
});
