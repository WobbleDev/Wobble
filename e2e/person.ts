import { expect, type Page } from '@playwright/test';

/**
 * Person-specific state (the selected Worker) is private renderer memory, so a spec
 * cannot seed it through the address. It selects the way a user does, on an open Mapping,
 * through the Map table row that names the Worker.
 */
export async function selectOnMap(page: Page, workerId: string): Promise<void> {
	const row = page.locator(`[data-map-table-row="${workerId}"]`);
	await expect(row).toBeAttached();
	await row.dispatchEvent('click');
	await expect(row).toHaveAttribute('aria-selected', 'true');
}
