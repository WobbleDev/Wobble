import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { addAttributeForm, workerColumn } from './configuration-outline.ts';

test.use({ locale: 'es-MX' });

/**
 * Configuration in Latin American Spanish: the framing, the Attribute editor and a
 * user-entered Worksite name that must stay exactly as typed.
 */

test('shows Spanish Configuration controls and keeps an entered Worksite name verbatim', async ({
	page,
	activeWorksite
}) => {
	await page.goto('/configuration');
	await appReady(page);

	await expect(page.getByRole('heading', { name: 'Configuración', level: 1 })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Sobre cada Trabajador' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Sobre cada Asignación de trabajo' })).toHaveCount(
		0
	);
	await expect(page.getByTestId('assignment-column')).toHaveCount(0);
	await expect(
		workerColumn(page).getByRole('heading', { name: 'Atributos', exact: true })
	).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Asuntos laborales', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Idiomas', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Zona de peligro', exact: true })).toBeVisible();
	await expect(page.getByLabel('Trabajadores por Líder')).toHaveValue('5');
	await expect(page.getByTestId('worksite-card').getByText('Un Líder por cada')).toBeVisible();
	await expect(
		page.getByTestId('worksite-card').getByText('trabajadores', { exact: true })
	).toBeVisible();

	const name = `Cocina Central ${Date.now()}`;
	// The accessible name carries the visible Worksite name (WCAG 2.5.3).
	await page
		.getByRole('button', { name: `Editar nombre del lugar de trabajo: ${activeWorksite.name}` })
		.click();
	const input = page.getByRole('textbox', { name: 'Nombre del lugar de trabajo' });
	await input.fill(name);
	await input.press('Enter');

	await page.getByRole('button', { name: 'Guardar todo' }).click();
	await expect(page.getByRole('button', { name: 'Guardar todo' })).toHaveCount(0);

	await page.reload();
	await appReady(page);
	await expect(
		page.getByRole('button', { name: `Editar nombre del lugar de trabajo: ${name}` })
	).toContainText(name);
});

test('edits an Attribute through Spanish labels and validation', async ({ page }) => {
	await page.goto('/configuration');
	await appReady(page);

	await workerColumn(page).getByTestId('add-attribute').click();
	const form = addAttributeForm(workerColumn(page));
	await expect(page.getByText('Guarda los cambios después de agregar el atributo')).toBeVisible();
	await expect(
		form.getByRole('button', { name: /Tipo de atributo: Selección única/ })
	).toBeVisible();
	await expect(form.getByRole('button', { name: /Alcance:/ })).toHaveCount(0);
	await expect(
		page.getByText('Calificaciones, tipo de empleo y otros datos personales.')
	).toBeVisible();

	// An empty name is rejected with the Spanish inline error.
	await form.getByRole('button', { name: 'Agregar atributo', exact: true }).click();
	await expect(page.getByText('Ingresa un nombre de atributo.')).toBeVisible();

	await page.getByLabel('Nombre visible').fill('Turno');
	await form.getByRole('button', { name: 'Agregar atributo', exact: true }).click();
	await expect(
		page.getByRole('button', { name: 'Mostrar u ocultar opciones de Turno' })
	).toBeVisible();

	await page.getByRole('button', { name: 'Descartar' }).click();
	await expect(
		page.getByRole('button', { name: 'Mostrar u ocultar opciones de Turno' })
	).toHaveCount(0);
});
