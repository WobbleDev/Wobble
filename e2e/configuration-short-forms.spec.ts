import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { openConfiguration } from './pages.ts';
import { appReady } from './page-ready.ts';
import { createWorker } from './api.ts';
import { wireDefinitions } from './answer-wire.ts';
import { addValue, answerRow, openAttributeEditor, saveAll } from './configuration-outline.ts';
import { SHORT_FORM_LIMIT } from '../src/lib/shared/short-form.ts';

/**
 * Short forms in the Configuration outline (ADR 0046): the core suggests one for every
 * new or renamed value, the field greys a generated form, typing makes it edited, and
 * the Save bar refuses more than ten graphemes.
 */

async function seedDepartments(request: APIRequestContext, values: string[]) {
	const id = `dept-${randomUUID().slice(0, 8)}`;
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([{ id, name: 'Department', kind: 'category', options: values }])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	return id;
}

const field = (row: Locator, name: string) =>
	row.getByRole('textbox', { name: `Short form of ${name}`, exact: true });

async function storedForms(request: APIRequestContext, attributeId: string) {
	const dataset = await request.get('/api/dataset');
	const attribute = (
		(await dataset.json()) as {
			attributes: {
				id: string;
				options: { value: string; shortForm: string; shortFormOrigin: string }[];
			}[];
		}
	).attributes.find((candidate) => candidate.id === attributeId)!;
	return Object.fromEntries(
		attribute.options.map((option) => [option.value, [option.shortForm, option.shortFormOrigin]])
	);
}

test('a new value shows a greyed suggestion, typing makes it edited, and eleven characters are refused', async ({
	page,
	request
}) => {
	const id = await seedDepartments(request, ['Kitchen']);
	await openConfiguration(page);
	await addValue(page, 'Department', 'Customer Service');

	const row = answerRow(page, 'Customer Service', 'Department');
	const input = field(row, 'Customer Service');
	await expect(input).toHaveValue('Cust. Svc.');
	await expect(input).toHaveAttribute('data-origin', 'generated');
	await expect(input).toHaveClass(/text-ink-3/);

	await input.fill('Eleven char');
	await expect(input).toHaveAttribute('data-origin', 'edited');
	await expect(input).not.toHaveClass(/text-ink-3/);
	await expect(row.getByTestId('short-form-count')).toHaveText(`11/${SHORT_FORM_LIMIT}`);
	await expect(input).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByRole('button', { name: 'Save all', exact: true })).toBeDisabled();

	await input.fill('CS');
	await expect(row.getByTestId('short-form-count')).toHaveText(`2/${SHORT_FORM_LIMIT}`);
	await expect(input).not.toHaveAttribute('aria-invalid', 'true');
	await saveAll(page);

	expect(await storedForms(request, id)).toEqual({
		Kitchen: ['Kitchen', 'generated'],
		'Customer Service': ['CS', 'edited']
	});
	await page.reload();
	await appReady(page);
	await openAttributeEditor(page, 'Department');
	const reloaded = field(answerRow(page, 'Customer Service', 'Department'), 'Customer Service');
	await expect(reloaded).toHaveValue('CS');
	await expect(reloaded).toHaveAttribute('data-origin', 'edited');
});

test('a rename refreshes a generated Short form but not an edited one, and clearing returns to generated', async ({
	page,
	request
}) => {
	const id = await seedDepartments(request, ['Customer Service', 'Maintenance Hub']);
	await openConfiguration(page);
	await openAttributeEditor(page, 'Department');
	const rename = async (from: string, to: string) => {
		await page.getByRole('button', { name: `Edit ${from}` }).click();
		const box = page.getByRole('textbox', { name: `Rename ${from}` });
		await box.fill(to);
		await box.press('Enter');
	};

	const generated = field(answerRow(page, 'Customer Service', 'Department'), 'Customer Service');
	await expect(generated).toHaveValue('Cust. Svc.');
	await rename('Customer Service', 'Night Service');
	await expect(field(answerRow(page, 'Night Service', 'Department'), 'Night Service')).toHaveValue(
		'Night Svc.'
	);

	const edited = field(answerRow(page, 'Maintenance Hub', 'Department'), 'Maintenance Hub');
	await edited.fill('MX');
	await rename('Maintenance Hub', 'Facilities Hub');
	const renamed = field(answerRow(page, 'Facilities Hub', 'Department'), 'Facilities Hub');
	await expect(renamed).toHaveValue('MX');
	await expect(renamed).toHaveAttribute('data-origin', 'edited');

	// Clearing the edit returns it to generated, and the core supplies a fresh suggestion.
	await renamed.fill('');
	await renamed.blur();
	await expect(renamed).toHaveAttribute('data-origin', 'generated');
	await expect(renamed).toHaveValue('Facilitie…');
	await saveAll(page);
	expect(await storedForms(request, id)).toEqual({
		'Night Service': ['Night Svc.', 'generated'],
		'Facilities Hub': ['Facilitie…', 'generated']
	});
});

test('the field is named, and Shift+F2 on a row moves into it', async ({ page, request }) => {
	await seedDepartments(request, ['Kitchen']);
	await openConfiguration(page);
	await openAttributeEditor(page, 'Department');
	const row = answerRow(page, 'Kitchen', 'Department');
	await row.focus();
	await page.keyboard.press('Shift+F2');
	await expect(field(row, 'Kitchen')).toBeFocused();
	await page.keyboard.type('KT');
	await expect(field(row, 'Kitchen')).toHaveValue('KT');
	await page.keyboard.press('Escape');
	await expect(row).toBeFocused();
});

test('an edited Short form appears in an Agitations header', async ({ page, request }) => {
	const id = await seedDepartments(request, ['Customer Service North', 'Maintenance Hub']);
	const agitation = await request.post('/api/agitations', { data: { text: 'Pay' } });
	const agitationId = (await agitation.json()).agitation.id as string;
	for (const value of ['Customer Service North', 'Maintenance Hub']) {
		await createWorker(request, {
			name: `Worker ${value}`,
			assessment: 'Supporter',
			attributes: { [id]: value },
			agitations: [agitationId]
		});
	}
	await openConfiguration(page);
	await openAttributeEditor(page, 'Department');
	await field(
		answerRow(page, 'Customer Service North', 'Department'),
		'Customer Service North'
	).fill('CSN');
	await saveAll(page);

	await page.setViewportSize({ width: 390, height: 874 });
	await page.goto('/overview?by=' + id);
	await appReady(page);
	const card = page.getByRole('region', { name: 'Agitations' });
	await expect(card).toHaveAttribute('data-agitations-ready', 'true');
	await expect(
		card.locator('[data-agitations-headers] th[title="Customer Service North"] [data-group-name]')
	).toHaveText('CSN');
});
