import { expect, test } from './fixtures.ts';
import { appReady } from './page-ready.ts';

/** Overrides the WebView's ordered preferences before any app module runs. */
const preferredLanguages = (page: import('@playwright/test').Page, languages: string[]) =>
	page.addInitScript((values) => {
		Object.defineProperty(navigator, 'languages', { configurable: true, get: () => values });
		Object.defineProperty(navigator, 'language', {
			configurable: true,
			get: () => values[0] ?? 'en'
		});
	}, languages);

test.describe('Spanish from the computer language', () => {
	test.use({ locale: 'es-MX' });

	test('shows Spanish navigation and headings without an explicit preference', async ({ page }) => {
		await page.goto('/workers');
		await appReady(page);

		const rail = page.getByRole('navigation', { name: 'Lugar de trabajo' });
		await expect(page.getByRole('heading', { name: 'Trabajadores', level: 1 })).toBeVisible();
		await expect(rail.getByRole('link', { name: 'Resumen', exact: true })).toBeVisible();
		await expect(rail.getByRole('link', { name: 'Trabajadores', exact: true })).toBeVisible();
		await expect(rail.getByRole('link', { name: 'Mapa', exact: true })).toBeVisible();
		await expect(rail.getByRole('link', { name: 'Ajustes', exact: true })).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');
		await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
	});
});

test.describe('an unsupported computer language', () => {
	test.use({ locale: 'fr-FR' });

	test('keeps the English shell', async ({ page }) => {
		await page.goto('/workers');
		await appReady(page);

		await expect(page.getByRole('heading', { name: 'Workers', level: 1 })).toBeVisible();
		await expect(
			page
				.getByRole('navigation', { name: 'Worksite' })
				.getByRole('link', { name: 'Overview', exact: true })
		).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	});
});

test('walks the full preferred-language list in order', async ({ page }) => {
	await preferredLanguages(page, ['fr-CA', 'es-MX', 'en-US']);
	await page.goto('/overview');
	await appReady(page);

	await expect(page.getByRole('heading', { name: 'Resumen', level: 1 })).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');
});

test('stops at an earlier English preference', async ({ page }) => {
	await preferredLanguages(page, ['fr-CA', 'en-US', 'es-MX']);
	await page.goto('/overview');
	await appReady(page);

	await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('survives malformed preferences and falls back to English', async ({ page }) => {
	await preferredLanguages(page, ['', 'not a tag', '??']);
	await page.goto('/overview');
	await appReady(page);

	await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test.describe('the pre-framework splash', () => {
	test.use({ locale: 'es-MX' });

	test('uses the computer language before any bundle loads', async ({ page }) => {
		// Keep the splash up by refusing the app bundle: this is the document's own
		// first paint, not the mounted shell.
		await page.route('**/_app/**', (route) => route.abort());
		await page.goto('/overview', { waitUntil: 'domcontentloaded' });

		await expect(page.locator('#splash .splash-sr')).toHaveText('Cargando Wobble');
		// The launch shuffles the phrases, so any one of the Spanish set is correct.
		const spanishPhrases = [
			'Uniéndonos a la gran banda industrial...',
			'Sacando a los jefes de nuestras espaldas...',
			'Haciendo rodar el sindicato...',
			'Buscando a los neutrales en el condado de Harlan...',
			'Mostrando una tarjeta a la Guardia Nacional...'
		];
		const line = (await page.locator('#splash-line').textContent())?.trim() ?? '';
		expect(spanishPhrases).toContain(line);
		await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');
		await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
	});

	test('falls back safely when the startup hint is corrupt', async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('wobble.language', '{not json'));
		await page.route('**/_app/**', (route) => route.abort());
		await page.goto('/overview', { waitUntil: 'domcontentloaded' });

		await expect(page.locator('#splash .splash-sr')).toHaveText('Cargando Wobble');
	});

	test('a stale explicit cache cannot override authoritative Settings', async ({ page }) => {
		await page.addInitScript(() =>
			localStorage.setItem(
				'wobble.language',
				JSON.stringify({ preference: 'en', appliedLocale: 'en' })
			)
		);
		await page.goto('/workers');
		await appReady(page);

		// The stale hint may word the splash, but the default registry preference is
		// `system`, so the mounted app follows the computer and repairs the hint.
		await expect(page.getByRole('heading', { name: 'Trabajadores', level: 1 })).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', 'es-419');
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('wobble.language')))
			.toBe(JSON.stringify({ preference: 'system', appliedLocale: 'es-419' }));
	});
});
