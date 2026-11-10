import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { settled, waitForMapReady } from './map.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

/**
 * The Overview and Mapping presentation in the shipped Spanish catalog. The specs
 * seed canonical English Assessment values and user-authored content through the
 * API; the interface must translate only its own words.
 */
test.use({ locale: 'es-MX', reducedMotion: 'reduce' });

test('reads Spanish Mapping controls, the Map table, and an Isolated selection', async ({
	page,
	request
}) => {
	const departmentId = randomUUID();
	const roleId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: ['Front of House', 'Back of House']
			},
			{ id: roleId, name: 'Role', kind: 'category', options: ['Server', 'Cook'] }
		])
	});
	expect(configured.ok()).toBeTruthy();

	const ids: string[] = [];
	for (const worker of [
		{ name: 'Ana', assessment: 'Leader', department: 'Front of House', role: 'Server' },
		{ name: 'Beto', assessment: 'Supporter', department: 'Front of House', role: 'Cook' },
		{ name: 'Carla', assessment: 'Disengaged', department: 'Back of House', role: 'Server' },
		{ name: 'Diego', assessment: 'Unassessed', department: 'Back of House', role: 'Cook' }
	] as const) {
		const created = await request.post('/api/workers', {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: worker.assessment,
				attributes: wireWorkerAttributes({
					[departmentId]: worker.department,
					[roleId]: worker.role
				}),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status()).toBe(201);
		ids.push((await created.json()).worker.id);
	}
	// One Relationship, so the reading has a tie to state.
	const related = await request.put(`/api/workers/${ids[0]}`, {
		data: {
			name: 'Ana',
			email: '',
			phone: '',
			assessment: 'Leader',
			attributes: wireWorkerAttributes({ [departmentId]: 'Front of House', [roleId]: 'Server' }),
			agitations: [],
			languages: [],
			relationships: [ids[1]],
			notes: []
		}
	});
	expect(related.ok()).toBeTruthy();

	await page.setViewportSize({ width: 1440, height: 1080 });
	await page.goto('/mapping');
	await appReady(page);
	await waitForMapReady(page);

	// Controls.
	await expect(page.getByRole('searchbox', { name: 'Buscar un trabajador' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Filtrar' })).toBeVisible();
	await expect(page.getByRole('group', { name: 'Clave de colores de evaluación' })).toBeVisible();
	await expect(
		page.getByRole('img', { name: 'El tamaño del punto muestra las relaciones, de 0 a 5 o más' })
	).toBeVisible();
	await expect(page.getByRole('button', { name: /^Líder, 1 trabajador, visible$/ })).toBeVisible();

	// The Highlight builder speaks Spanish throughout: controls, sentence and values.
	await page.getByRole('button', { name: 'Resaltar', exact: true }).click();
	await expect(page.getByTestId('highlight-group').first()).toHaveAccessibleName(
		/Trabajadores que cumplen/
	);
	await expect(page.getByTestId('highlight-add-rule')).toHaveText('Añadir una condición');
	await expect(page.getByTestId('highlight-field')).toHaveText('Idiomas');
	await expect(page.getByTestId('highlight-operator')).toHaveText('incluye alguno de los');
	await expect(
		page.getByText('Los trabajadores que no coinciden se atenúan. No se oculta nada.')
	).toBeVisible();
	await expect(page.getByText('Workers who match')).toHaveCount(0);
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('highlight-group')).toHaveCount(0);

	// Grouping keeps option identifiers but translates the controls around them.
	const groupTrigger = page.getByRole('button', { name: /^(Agrupar|Grupo)(:|$)/ });
	await groupTrigger.click();
	await page.locator('#map-group-by').click();
	await expect(page.getByRole('option').filter({ hasText: 'Ninguno' })).toHaveCount(1);
	await page.getByRole('option', { name: 'Department' }).click();
	await expect(groupTrigger).toContainText('Department');
	if ((await groupTrigger.getAttribute('aria-expanded')) !== 'true') await groupTrigger.click();
	await page.locator('#map-sub-group-by').click();
	await page.getByRole('option', { name: 'Role' }).click();
	await expect(groupTrigger).toContainText('Role');

	// The Map table states exactly the Workers and Relationships the map draws.
	const table = page.getByRole('region', { name: 'Tabla del mapa' });
	await expect(table).toBeAttached();
	await expect(page.getByRole('columnheader', { name: 'Trabajador' })).toBeAttached();
	await expect(page.getByRole('columnheader', { name: 'Evaluación' })).toBeAttached();
	await expect(page.getByRole('columnheader', { name: 'Relaciones', exact: true })).toBeAttached();
	await expect(
		page.getByRole('columnheader', { name: 'Relaciones fuera del grupo' })
	).toBeAttached();

	const drawnIds = async () =>
		page
			.locator('svg g[role="button"][data-node-id]')
			.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-id')).sort());
	const tableIds = async () =>
		page
			.locator('[data-map-table-row]')
			.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-map-table-row')).sort());
	await expect.poll(async () => (await tableIds()).length).toBe((await drawnIds()).length);
	expect(await tableIds()).toEqual(await drawnIds());
	await expect(table).toContainText('Evaluación');

	// Selecting a Worker opens the Spanish record and its actions.
	await page.locator('svg g[role="button"][data-node-id]').first().click();
	const record = page.getByRole('region', { name: 'Ficha del trabajador' });
	await expect(record).toBeVisible();
	await expect(record.getByRole('button', { name: 'Aislar' })).toBeVisible();
	await expect(record.getByRole('link', { name: 'Abrir en Trabajadores' })).toBeVisible();
	await expect(record).toContainText('Idiomas');
	await expect(record).toContainText('No hay idiomas registrados.');

	// Isolate narrows both the drawing and the table to the same membership.
	await record.getByRole('button', { name: 'Aislar' }).click();
	await expect(page.getByText(/entorno aislado/)).toBeVisible();
	await expect.poll(async () => (await tableIds()).length).toBe((await drawnIds()).length);
	expect(await tableIds()).toEqual(await drawnIds());

	// Clearing every Assessment filter states the Spanish empty map and restores it.
	for (const assessment of [
		'Líder',
		'Activista',
		'Simpatizante',
		'Distante',
		'Hostil',
		'Sin evaluar'
	]) {
		await page.getByRole('button', { name: new RegExp(`^${assessment},`) }).click();
	}
	await expect(
		page.getByText('Ningún trabajador coincide con los filtros actuales.')
	).toBeVisible();
	await page.getByRole('button', { name: 'Borrar filtros' }).click();
	expect(
		await settled(async () => page.locator('svg g[role="button"][data-node-id]').count())
	).toBeGreaterThan(0);
	await expect(page.getByText('Ningún trabajador coincide con los filtros actuales.')).toHaveCount(
		0
	);
});
