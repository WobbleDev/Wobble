import { expect, test } from '@playwright/test';
import { activateWorksite, activeWorksiteHeaderName, followActiveWorksite } from './api.ts';

// The first test owns the empty-database state (it creates the first Worksite), so this
// file's tests run in order rather than in parallel against the one shared database.
test.describe.configure({ mode: 'serial' });

test('new Worksites open setup, accept an optional name and import contacts only into that Worksite', async ({
	page,
	context
}) => {
	await followActiveWorksite(context);

	// Encrypted first launch gates on passphrase creation before any Worksite setup.
	await page.goto('/overview');
	await expect(page.getByRole('heading', { name: 'Create a passphrase' })).toBeVisible();
	await page.getByLabel('Passphrase', { exact: true }).fill('onboarding fixture passphrase');
	await page
		.getByLabel('Confirm passphrase', { exact: true })
		.fill('onboarding fixture passphrase');
	await page.getByRole('button', { name: 'Create passphrase', exact: true }).click();
	await expect(page.getByRole('button', { name: 'New Worksite' })).toBeVisible();

	// The empty shell is also reachable at the route that draws the bullseye
	// chart backdrop, whose pointer pass-through disables the shell's children. This
	// control has to re-enable the pointer for itself, or the door into the app
	// is dead on /overview. A trial click runs the same hit-test a real one does,
	// without creating the Worksite yet.
	await page.goto('/overview');
	const createFirstWorksite = page.getByRole('button', { name: 'New Worksite' });
	await expect(createFirstWorksite).toBeVisible();
	await createFirstWorksite.click({ trial: true });

	await page.goto('/workers');

	const blockedResponses = await page.evaluate(async () => {
		const requests = [
			{ path: '/api/workers', method: 'POST', payload: {} },
			{ path: '/api/attributes', method: 'PUT', payload: [] },
			{ path: '/api/agitations', method: 'POST', payload: { text: 'Test agitation' } }
		];

		return Promise.all(
			requests.map(async ({ path, method, payload }) => {
				const response = await fetch(path, {
					method,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload)
				});

				return { status: response.status, body: await response.json() };
			})
		);
	});
	expect(blockedResponses).toEqual(
		Array.from({ length: 3 }, () => ({
			status: 409,
			body: { message: 'There is no Active Worksite.' }
		}))
	);

	// /workers shows the empty state, not a blank page; its action is the create flow.
	await expect(
		page.getByRole('heading', { name: 'Create a worksite to get started' })
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'New Worksite' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Import contacts' })).toHaveCount(0);
	await page.getByRole('button', { name: 'New Worksite' }).click();

	await expect(page).toHaveURL(/\/overview\?setup=1$/);
	const setupDialog = page.getByRole('dialog', { name: 'Set up your worksite' });
	await expect(setupDialog).toBeVisible();
	await expect(setupDialog.getByLabel('Worksite name')).toHaveValue('My Worksite');
	await setupDialog.getByRole('button', { name: 'Skip setup' }).click();
	await expect(page).toHaveURL(/\/overview$/);
	// The dialog lingers briefly after the URL drops ?setup=1 and has its own
	// "Import contacts" button, so wait it out before asserting the top bar's.
	await expect(setupDialog).toBeHidden();
	await expect(page.getByRole('button', { name: 'Import contacts' })).toBeVisible();

	const firstWorksite = await page.evaluate(async () => {
		const response = await fetch('/api/worksite');
		return (await response.json()).worksite;
	});
	expect(firstWorksite.name).toBe('My Worksite');

	const secondWorksite = await page.evaluate(async () => {
		const response = await fetch('/api/worksite', { method: 'POST' });
		return (await response.json()).worksite;
	});
	await page.goto('/overview?setup=1');
	const secondSetup = page.getByRole('dialog', { name: 'Set up your worksite' });
	await expect(secondSetup.getByLabel('Worksite name')).toHaveValue('My Worksite 2');
	await secondSetup.getByLabel('Worksite name').fill('Onboarding test');
	await secondSetup.getByRole('button', { name: 'Import contacts' }).click();

	const importer = page.getByRole('dialog', { name: 'Import contacts from CSV' });
	await expect(importer).toBeVisible();
	await importer.getByLabel('CSV file').setInputFiles({
		name: 'contacts.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			'Name,Phone,Email,Ignored\nAda Lovelace,555-0101,ada@example.test,not imported\n,555-0102,,missing name\nGrace Hopper,,,also ignored'
		)
	});
	await expect(importer.getByText('1 row has no Name and will be skipped.')).toBeVisible();
	await expect(importer.getByText('2 valid contacts will be imported.')).toBeVisible();
	await expect(importer.getByText('555-0101', { exact: true })).toBeVisible();
	await expect(importer.getByText('ada@example.test', { exact: true })).toBeVisible();
	// Exact, so "Ready, phone not imported" on the flagged row is not what this reads.
	await expect(importer.getByText('not imported', { exact: true })).toHaveCount(0);
	await importer.getByRole('button', { name: 'Import 2 contacts' }).click();
	// The preview stage has its own status lines; the completion one names the import.
	await expect(importer.getByRole('status').filter({ hasText: 'Imported' })).toContainText(
		'Imported 2 contacts.'
	);
	await importer.getByRole('button', { name: 'Done' }).click();

	await expect(page).toHaveURL(/\/overview$/);
	const activeWorksite = await page.evaluate(async () => {
		const response = await fetch('/api/worksite');
		return (await response.json()).worksite;
	});
	expect(activeWorksite).toEqual(
		expect.objectContaining({ id: secondWorksite.id, name: 'Onboarding test' })
	);

	await page.goto('/workers');
	// The Name cell holds the desktop span and the below-lg "Show details" button, so
	// the row is the one element that names each imported Worker exactly once.
	await expect(page.getByRole('row', { name: /Ada Lovelace/ })).toBeVisible();
	await expect(page.getByRole('row', { name: /Grace Hopper/ })).toBeVisible();

	await page.evaluate(async (id) => {
		await fetch('/api/worksite/active', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id })
		});
	}, firstWorksite.id);
	await page.goto('/workers');
	await expect(page.getByRole('row', { name: /Ada Lovelace/ })).toHaveCount(0);
	await expect(page.getByRole('row', { name: /Grace Hopper/ })).toHaveCount(0);
});

/*
 * "Finish setup" takes a different path out of the dialog than the "Skip setup" above:
 * Skip closes the dialog itself (Dialog.Close → onOpenChange → dismissSetup), while
 * Finish saves the name, closes the dialog and then drops `?setup=1`. An empty name skips
 * the PUT entirely, which separates the save from the dismissal.
 *
 * Closing it is load-bearing rather than tidiness: `replaceState` rewrites the address but
 * leaves `page.url` untouched, so the page's `{#if}` never sees `?setup=1` go away.
 * Leaning on that alone left the dialog and its overlay on screen (issue 32).
 */
for (const variant of [
	{ label: 'a typed name', typed: 'Finished Worksite' },
	{ label: 'an empty name', typed: '' }
] as const) {
	test(`Finish setup with ${variant.label} dismisses the setup dialog and keeps the name`, async ({
		page,
		context,
		request
	}) => {
		// Independent of the first-run state the spec above consumes: create a Worksite
		// and point both the context header and the app's stored memory at it.
		const created = await request.post('/api/worksite');
		expect(created.status()).toBe(201);
		const { worksite } = (await created.json()) as { worksite: { id: string; name: string } };
		await activateWorksite(context, worksite.id);
		await followActiveWorksite(context);

		const puts: unknown[] = [];
		page.on('request', (sent) => {
			if (sent.url().endsWith('/api/worksite') && sent.method() === 'PUT') {
				puts.push(sent.postDataJSON());
			}
		});

		await page.goto('/overview?setup=1');
		const setupDialog = page.getByRole('dialog', { name: 'Set up your worksite' });
		await expect(setupDialog).toBeVisible();
		await expect(setupDialog.getByLabel('Worksite name')).toHaveValue(worksite.name);

		await setupDialog.getByLabel('Worksite name').fill(variant.typed);
		await setupDialog.getByRole('button', { name: 'Finish setup' }).click();

		// Gone, not merely hidden: the content and its overlay both leave the DOM.
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
		await expect(page).toHaveURL(/\/overview$/);
		await expect(
			page.getByRole('button', {
				name: `Active Worksite: ${variant.typed || worksite.name}`,
				exact: true
			})
		).toBeVisible();
		expect(new URL(page.url()).searchParams.has('setup')).toBe(false);

		console.log(`Finish setup with ${variant.label} sent PUT bodies:`, JSON.stringify(puts));
		expect(puts).toEqual(variant.typed ? [{ name: variant.typed }] : []);

		// The name is on the record and setup does not come back after a reload.
		await page.reload();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(new URL(page.url()).searchParams.has('setup')).toBe(false);
		const reloaded = await request.get('/api/worksite', {
			headers: { [activeWorksiteHeaderName]: worksite.id }
		});
		const persisted = (await reloaded.json()) as { worksite: { name: string } };
		expect(persisted.worksite.name).toBe(variant.typed || worksite.name);
	});
}

for (const action of ['Skip setup', 'Finish setup', 'Import contacts'] as const) {
	test(`${action} removes only the setup parameter and replaces the current history entry`, async ({
		page,
		context,
		request
	}) => {
		const created = await request.post('/api/worksite');
		expect(created.status()).toBe(201);
		const { worksite } = (await created.json()) as { worksite: { id: string } };
		await activateWorksite(context, worksite.id);
		await followActiveWorksite(context);

		await page.goto('/workers');
		// Unrelated repeated params must survive; Overview owns and canonicalizes `f`.
		await page.goto('/overview?setup=1&ref=contacts&ref=welcome#support');
		const setupDialog = page.getByRole('dialog', { name: 'Set up your worksite' });
		await setupDialog.getByRole('button', { name: action, exact: true }).click();
		if (action === 'Import contacts') {
			const importer = page.getByRole('dialog', { name: 'Import contacts from CSV' });
			await importer.getByRole('button', { name: 'Cancel', exact: true }).click();
		}

		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page).toHaveURL(/\/overview\?ref=contacts&ref=welcome#support$/);
		await page.reload();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page).toHaveURL(/\/overview\?ref=contacts&ref=welcome#support$/);
		await page.goBack();
		await expect(page).toHaveURL(/\/workers$/);
	});
}

test.describe('Spanish creation template', () => {
	test.use({ locale: 'es-MX' });

	test('creates Spanish default labels without relabeling an existing English Worksite', async ({
		page,
		context,
		request
	}) => {
		const created = await request.post('/api/worksite', {
			data: { templateLocale: 'es-419' }
		});
		expect(created.status()).toBe(201);
		const { worksite } = (await created.json()) as {
			worksite: { id: string; name: string };
		};
		expect(worksite.name).toMatch(/^Mi lugar de trabajo( \d+)?$/);

		const dataset = await request.get('/api/dataset', {
			headers: { [activeWorksiteHeaderName]: worksite.id }
		});
		expect(dataset.ok()).toBeTruthy();
		const body = (await dataset.json()) as {
			attributes: { name: string; kind: string; options: unknown[] }[];
			worksite: { name: string; committeeGoal: number; committeeTarget: number };
		};
		expect(body.attributes.map((attribute) => attribute.name)).toEqual([
			'Departamento',
			'Puesto',
			'Turnos'
		]);
		expect(body.attributes.map((attribute) => attribute.kind)).toEqual([
			'category',
			'category',
			'tag'
		]);
		expect(body.attributes.every((attribute) => attribute.options.length === 0)).toBe(true);
		expect(body.worksite).toEqual({
			id: worksite.id,
			name: worksite.name,
			committeeGoal: 5,
			committeeTarget: 5
		});

		await activateWorksite(context, worksite.id);
		await followActiveWorksite(context);
		await page.goto('/overview?setup=1');

		const dialog = page.getByRole('dialog', { name: 'Configura tu lugar de trabajo' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByLabel('Nombre del lugar de trabajo')).toHaveValue(worksite.name);
		await expect(dialog.getByRole('button', { name: 'Omitir configuración' })).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Terminar configuración' })).toBeVisible();

		// An English Worksite created before this one keeps every label it was made with.
		const english = await request.get('/api/dataset');
		const englishBody = (await english.json()) as { attributes: { name: string }[] };
		expect(englishBody.attributes.map((attribute) => attribute.name)).toEqual([
			'Department',
			'Role',
			'Shifts'
		]);
	});
});
