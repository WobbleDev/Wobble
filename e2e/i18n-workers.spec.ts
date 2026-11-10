import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { openWorkersTable, seedInspectorWorkers } from './workers-table-page.ts';

/**
 * The Workers view in Latin American Spanish: table and record reading, contact
 * and Assessment editing, Notes, Relationships, Agitations, filters and bulk
 * actions, Contact import, and draft recovery. User content (names, Attribute
 * labels, Languages, Agitations) stays exactly as entered.
 */
test.use({ locale: 'es-MX', viewport: { width: 1440, height: 900 } });

const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');

/** The row for one Worker, by the name it keeps verbatim. */
const row = (page: Page, name: string) => page.getByRole('row', { name: new RegExp(name) });

/** Selects a Worker the way an organizer does: a click on the name cell. */
async function selectWorker(page: Page, name: string) {
	await row(page, name).locator('td').nth(1).click();
	await expect(
		page.getByRole('complementary', { name: `Detalles del trabajador: ${name}` })
	).toBeVisible();
}

/** The stored Assessment of a Worker, read through the same API the app uses. */
async function storedAssessment(request: APIRequestContext, name: string): Promise<string> {
	const body = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string; assessment: string; email: string; notes: { text: string }[] }[];
	};
	return body.workers.find((worker) => worker.name === name)?.assessment ?? '';
}

async function storedWorker(request: APIRequestContext, name: string) {
	const body = (await (await request.get('/api/dataset')).json()) as {
		workers: {
			name: string;
			email: string;
			notes: { text: string }[];
			agitations: string[];
			relationships: string[];
		}[];
	};
	return body.workers.find((worker) => worker.name === name);
}

test('the table and record read in Spanish while names and Worksite vocabulary stay verbatim', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers, rows: 3 });

	// The shared route title is Spanish; the table brings its own translated headings.
	await expect(page.getByRole('heading', { name: 'Trabajadores', level: 1 })).toBeVisible();
	const headers = (await page.getByRole('columnheader').allTextContents()).map((text) =>
		text.trim()
	);
	expect(headers).toEqual(['', 'Nombre', 'Evaluación', 'Idiomas', 'Department', 'Shifts']);
	await expect(page.getByRole('searchbox', { name: 'Buscar nombre' })).toBeVisible();
	await expect(page.getByTestId('worker-count')).toHaveText('3 trabajadores');
	await expect(page.getByRole('button', { name: 'Nuevo trabajador' })).toBeVisible();

	// User content is untouched: names, Attribute labels and Languages keep their text.
	await expect(row(page, 'Ada Lovelace').locator('[data-name-cell]')).toHaveText('Ada Lovelace');
	await expect(page.getByRole('columnheader', { name: 'Department' })).toBeVisible();
	await expect(row(page, 'Ada Lovelace').getByText('English')).toBeVisible();

	await selectWorker(page, 'Ada Lovelace');
	const ada = page.getByRole('complementary', { name: 'Detalles del trabajador: Ada Lovelace' });
	await expect(ada.locator('h3')).toHaveText([
		'Contacto',
		'Atributos',
		'Idiomas',
		'Notas',
		'Relaciones',
		'Asuntos laborales'
	]);
	await expect(ada.getByText('Correo electrónico', { exact: true })).toBeVisible();
	await expect(ada.getByText('Teléfono', { exact: true })).toBeVisible();

	// Assessment labels come from the one shared mapping: individual in the picker,
	// with Sin evaluar distinct from the five-level scale.
	await ada.getByRole('button', { name: 'Editar evaluación para Ada Lovelace' }).click();
	const menu = page.getByRole('menu');
	await expect(menu.getByRole('menuitemradio', { name: 'Líder' })).toBeVisible();
	await expect(menu.getByRole('menuitemradio', { name: 'Sin evaluar' })).toBeVisible();
	await menu.getByRole('menuitemradio', { name: 'Líder' }).click();
	await expect(page.getByTestId('status-line')).toContainText(
		'Se guardó Evaluación de Ada Lovelace'
	);
	expect(await storedAssessment(request, 'Ada Lovelace')).toBe('Leader');

	// A contact edit saves under its Spanish label, and the canonical value is stored.
	await ada.getByRole('button', { name: 'Editar correo electrónico' }).click();
	await ada.getByLabel('Correo electrónico').fill('ada.es@example.test');
	await ada.getByLabel('Correo electrónico').press('Enter');
	await expect(page.getByTestId('status-line')).toContainText(
		'Se guardó Correo electrónico de Ada Lovelace'
	);
	expect((await storedWorker(request, 'Ada Lovelace'))?.email).toBe('ada.es@example.test');

	// A refused contact write stays open with Spanish copy and keeps the typed value.
	await page.route('**/api/workers/*', (route) => route.abort());
	await ada.getByRole('button', { name: 'Editar correo electrónico' }).click();
	await ada.getByLabel('Correo electrónico').fill('not-an-email');
	await ada.getByLabel('Correo electrónico').press('Enter');
	await expect(ada.getByRole('alert')).toBeVisible();
	await expect(ada.getByLabel('Correo electrónico')).toHaveValue('not-an-email');
	await page.unroute('**/api/workers/*');
});

test('Notes, Relationships and Agitations are edited in Spanish', async ({ page, request }) => {
	await openWorkersTable(page, request, { seed: seedInspectorWorkers, rows: 3 });
	await selectWorker(page, 'Ada Lovelace');
	const ada = page.getByRole('complementary', { name: 'Detalles del trabajador: Ada Lovelace' });

	// A Note written in Spanish saves and reads back unchanged.
	await ada.getByRole('textbox', { name: 'Nota' }).fill('Hablé con Ada sobre el turno de noche.');
	await ada.getByRole('textbox', { name: 'Nota' }).press('ControlOrMeta+Enter');
	await expect(ada).toContainText('Hablé con Ada sobre el turno de noche.');
	await expect(page.getByTestId('status-line')).toContainText(
		'Se agregó una nota para Ada Lovelace'
	);

	// A Relationship is found through Spanish controls and reports in Spanish.
	await ada.getByRole('button', { name: 'Agregar relación' }).click();
	await ada.getByRole('searchbox', { name: 'Buscar trabajadores para relacionar' }).fill('grace');
	const list = ada.getByRole('list', { name: 'Trabajadores con quienes puedes relacionar' });
	await list.getByRole('button', { name: 'Grace Hopper, Simpatizante' }).click();
	await expect(page.getByTestId('status-line')).toContainText(
		'Se agregó una relación entre Ada Lovelace y Grace Hopper'
	);
	const grace = await storedWorker(request, 'Grace Hopper');
	const adaStored = await storedWorker(request, 'Ada Lovelace');
	expect(adaStored?.relationships.length).toBe(1);
	expect(grace?.relationships.length).toBe(1);

	// The Agitation section keeps its provisional Spanish term and user text verbatim.
	await expect(ada.getByRole('heading', { name: 'Asuntos laborales' })).toBeVisible();
	await ada.getByRole('button', { name: 'Quitar el asunto laboral Pay' }).click();
	await expect(page.getByTestId('status-line')).toContainText(
		'Se quitó un asunto laboral de Ada Lovelace'
	);
	await ada.getByRole('button', { name: 'Agregar asunto laboral' }).click();
	await ada.getByRole('searchbox', { name: 'Asunto laboral' }).fill('Domingos libres');
	await ada
		.getByRole('button', { name: 'Agregar "Domingos libres" como nuevo asunto laboral' })
		.click();
	await expect(page.getByTestId('status-line')).toContainText(
		'Se agregó un asunto laboral para Ada Lovelace'
	);
	const stored = await storedWorker(request, 'Ada Lovelace');
	expect(stored?.agitations.length).toBe(1);
});

test('filters and bulk updates use Spanish, keeping canonical filter values', async ({
	page,
	request
}) => {
	await openWorkersTable(page, request, { rows: 8 });

	// An empty search names what was searched and offers the Spanish clear action.
	const search = page.getByRole('searchbox', { name: 'Buscar nombre' });
	await search.fill('zzz');
	await expect(page.getByText('Ningún trabajador coincide con “zzz”.')).toBeVisible();
	await page.getByRole('button', { name: 'Borrar búsqueda' }).click();
	await expect(rows(page)).toHaveCount(8);

	// A configured-answer filter still keys on the answer id; the labels are translated.
	await page
		.getByRole('columnheader', { name: 'Department' })
		.getByRole('button', {
			name: 'Filtrar Department'
		})
		.click();
	await page.getByRole('menuitemcheckbox', { name: 'Front of House' }).click();
	await expect(rows(page)).toHaveCount(4);
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Borrar filtros' }).click();

	// Zero, one and many selected Workers each read as a complete Spanish message.
	await page.getByRole('checkbox', { name: 'Seleccionar a Ada Lovelace' }).check();
	await expect(page.getByTestId('bulk-bar')).toContainText('1 seleccionado');
	await page.getByRole('checkbox', { name: 'Seleccionar a Grace Hopper' }).check();
	await expect(page.getByTestId('bulk-bar')).toContainText('2 seleccionados');
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Borrar selección' }).click();
	await expect(page.getByTestId('bulk-bar')).toHaveCount(0);

	// A bulk Assessment change saves the canonical value and reports in Spanish.
	await page.getByRole('checkbox', { name: 'Seleccionar a Ada Lovelace' }).check();
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Editar', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Establecer evaluación' }).click();
	await page.getByRole('menuitem', { name: 'Líder' }).click();
	await expect(page.getByTestId('status-line')).toContainText(
		'Se guardó Evaluación para 1 trabajador'
	);
	expect(await storedAssessment(request, 'Ada Lovelace')).toBe('Leader');

	// An Assessment filter shows the translated label but filters by the canonical value.
	await page
		.getByRole('columnheader', { name: 'Evaluación' })
		.getByRole('button', {
			name: 'Filtrar Evaluación'
		})
		.click();
	await page.getByRole('menuitemcheckbox', { name: 'Líder' }).click();
	await expect(rows(page)).toHaveCount(1);
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Borrar filtros' }).click();
	await expect(rows(page)).toHaveCount(8);

	// A refused batch keeps its Spanish failure text.
	await page.route('**/api/workers/*', (route) => route.abort());
	await page.getByRole('checkbox', { name: 'Seleccionar a Grace Hopper' }).check();
	await page.getByTestId('bulk-bar').getByRole('button', { name: 'Editar', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Establecer evaluación' }).click();
	await page.getByRole('menuitem', { name: 'Activista' }).click();
	await expect(page.getByTestId('status-line')).toContainText(
		'No se pudo establecer la evaluación para 2 trabajadores.'
	);
	await expect(page.getByTestId('status-line').getByRole('alert')).toContainText(
		'Algunos cambios no se pudieron guardar.'
	);
	await page.unroute('**/api/workers/*');
});

test('Contact import explains unusable phones and skipped rows in Spanish', async ({
	page,
	request
}) => {
	await page.goto('/workers');
	await appReady(page);
	await page.getByRole('button', { name: 'Importar contactos' }).click();

	const importer = page.getByRole('dialog', { name: 'Importar contactos desde CSV' });
	await expect(importer).toBeVisible();
	await importer.getByLabel('Archivo CSV').setInputFiles({
		name: 'contactos.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			'Name,Phone\n' +
				'Ada Lovelace,5550100100\n' +
				'Grace Hopper,555.010.0100\n' +
				'Katherine Johnson,+1 555 010 0100\n' +
				'Dorothy Vaughan,\n' +
				'Mary Jackson,555-0101\n' +
				'Annie Easley,abc\n'
		)
	});

	await expect(importer.getByText('No es un número de 10 dígitos', { exact: true })).toHaveCount(2);
	await expect(importer.getByText('Lista, teléfono en blanco')).toHaveCount(2);
	await expect(importer.getByText('Lista', { exact: true })).toHaveCount(4);

	// The summary counts every row.
	const summary = importer.getByRole('status');
	await expect(summary).toContainText(
		'2 filas tienen un teléfono que no es un número de 10 dígitos'
	);
	await expect(summary).toContainText('filas 6 y 7 del CSV');

	// A missing Name is skipped, and the completion counts the phones left blank.
	await expect(importer.getByRole('button', { name: 'Importar 6 contactos' })).toBeEnabled();
	await importer.getByRole('button', { name: 'Importar 6 contactos' }).click();
	const completed = importer.getByRole('status').filter({ hasText: 'Se importaron' });
	await expect(completed).toContainText('Se importaron 6 contactos.');
	await expect(completed).toContainText('2 números de teléfono quedaron en blanco.');

	// The preview's promise is what the core stores.
	const body = (await (await request.get('/api/dataset')).json()) as {
		workers: { name: string; phone: string }[];
	};
	const stored = Object.fromEntries(body.workers.map((worker) => [worker.name, worker.phone]));
	expect(stored['Ada Lovelace']).toBe('(555) 010-0100');
	expect(stored['Mary Jackson']).toBe('');
	expect(stored['Annie Easley']).toBe('');
});

test('a restored draft banner reads in Spanish and Discard them forgets it', async ({
	page,
	request
}) => {
	const created = await request.post('/api/workers', {
		data: [{ name: 'Borrador Keeper' }, { name: 'Otra Persona' }]
	});
	expect(created.ok()).toBeTruthy();
	const body = (await (await request.get('/api/dataset')).json()) as {
		workers: { id: string; name: string }[];
	};
	const keeper = body.workers.find((worker) => worker.name === 'Borrador Keeper');
	expect(keeper).toBeTruthy();

	await page.goto('/workers');
	await appReady(page);
	await selectWorker(page, 'Borrador Keeper');
	const panel = page.getByRole('complementary', {
		name: 'Detalles del trabajador: Borrador Keeper'
	});
	await panel.getByRole('button', { name: 'Editar correo electrónico' }).click();
	await panel.getByLabel('Correo electrónico').fill('borrador@example.test');

	// The autosave lands about a second after the last keystroke.
	await expect
		.poll(async () => {
			const draft = (await (await request.get(`/api/worker-drafts/${keeper!.id}`)).json()) as {
				draft: unknown;
			};
			return draft.draft;
		})
		.not.toBeNull();

	await page.reload();
	await appReady(page);
	await selectWorker(page, 'Borrador Keeper');
	const restored = page.getByTestId('restored-draft');
	await expect(restored).toContainText('Se restauraron cambios sin guardar de');
	await panel.getByRole('button', { name: 'Descartarlos' }).click();
	await expect(restored).toHaveCount(0);
	await expect(panel.getByRole('textbox', { name: 'Correo electrónico' })).toHaveCount(0);
});
