import { expect, type Locator } from '@playwright/test';

/**
 * Drives the shared Select: open the trigger, then pick an option. A plain string is an
 * option value (an answer id or sentinel); `{ label }` matches the visible text and
 * `{ value }` the value explicitly. The trigger's `data-value` is the chosen value.
 */
export async function choose(
	trigger: Locator,
	option: string | { label: string } | { value: string }
): Promise<void> {
	await trigger.click();
	const page = trigger.page();
	if (typeof option === 'object' && 'label' in option) {
		await page.getByRole('option', { name: option.label, exact: true }).click();
	} else {
		const value = typeof option === 'string' ? option : option.value;
		await page.locator(`[role="option"][data-value="${value}"]`).click();
	}
	// The list animates out; wait for it so the next choice sees only its own options.
	await expect(page.getByRole('listbox')).toHaveCount(0);
}

/** The visible text of every option, read by opening the list and closing it again. */
export async function optionLabels(trigger: Locator): Promise<string[]> {
	await trigger.click();
	const labels = await trigger.page().getByRole('option').allTextContents();
	await trigger.page().keyboard.press('Escape');
	await expect(trigger.page().getByRole('listbox')).toHaveCount(0);
	return labels.map((label) => label.trim());
}
