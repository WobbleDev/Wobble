import { expect, test } from './fixtures.ts';
import { seedRelationshipHub } from './mapping-responsiveness.ts';

test.use({ reducedMotion: 'reduce' });
test.setTimeout(90_000);

test('navigation rail to Mapping mounts the canvas and finds the worker', async ({
	page,
	request
}) => {
	await seedRelationshipHub(request);
	await page.goto('/overview');
	const mappingTab = page.getByRole('link', { name: 'Mapping', exact: true });
	await expect(mappingTab).toBeVisible();
	await mappingTab.click();
	await expect(page).toHaveURL(/\/mapping$/);
	await expect(page.getByTestId('relationship-map-layer')).toBeAttached({ timeout: 30_000 });
	const search = page.getByRole('searchbox', { name: 'Find a worker' });
	await expect(search).toBeVisible({ timeout: 30_000 });
	await search.fill('Map Worker 50');
	await expect(page.getByTestId('relationship-map-canvas').getByRole('status')).toContainText(
		'1 match',
		{ timeout: 10_000 }
	);
});
