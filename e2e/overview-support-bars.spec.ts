import { randomUUID } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { test, expect, isReplay } from './fixtures.ts';
import { appReady } from './page-ready.ts';
import { wireDefinitions } from './answer-wire.ts';
import { createWorker } from './api.ts';

async function geometry(bar: Locator) {
	return bar.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		const segments = [...element.querySelectorAll<HTMLElement>('.seg')].map((segment) => {
			const box = segment.getBoundingClientRect();
			return {
				label: segment.getAttribute('aria-label'),
				left: box.left - bounds.left,
				width: box.width,
				support: segment.classList.contains('support'),
				color: getComputedStyle(segment).backgroundColor
			};
		});
		return {
			segments,
			support:
				(segments
					.filter((segment) => segment.support)
					.reduce((sum, segment) => sum + segment.width, 0) /
					bounds.width) *
				100,
			shares: segments.map((segment) => (segment.width / bounds.width) * 100)
		};
	});
}

for (const colorScheme of ['light', 'dark'] as const) {
	test(`support bar shares agree with the percentage and stay fixed on hover and focus in ${colorScheme}`, async ({
		page,
		request
	}) => {
		const departmentId = randomUUID();
		const fixtures = [
			{
				name: 'Mixed',
				percent: 60,
				assessments: ['Leader', 'Activist', 'Supporter', 'Disengaged', 'Unassessed'],
				shares: [20, 20, 20, 20, 20]
			},
			{
				name: 'Unassessed only',
				percent: 0,
				assessments: ['Unassessed', 'Unassessed'],
				shares: [100]
			},
			{ name: 'Support only', percent: 100, assessments: ['Supporter', 'Supporter'], shares: [100] }
		];
		if (!isReplay) {
			expect(
				(
					await request.put('/api/attributes', {
						data: wireDefinitions([
							{
								id: departmentId,
								name: 'Department',
								kind: 'category',
								options: fixtures.map((fixture) => fixture.name)
							}
						])
					})
				).ok()
			).toBeTruthy();
			for (const fixture of fixtures) {
				for (const [index, assessment] of fixture.assessments.entries()) {
					await createWorker(request, {
						name: fixture.name + ' ' + index,
						assessment,
						attributes: { [departmentId]: fixture.name }
					});
				}
			}
		}
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.emulateMedia({ colorScheme });
		await page.goto('/overview');
		await appReady(page);
		const card = page.getByRole('region', { name: 'By Department' });
		await expect(card).toHaveAttribute('data-breakdown-ready', 'true');
		for (const fixture of fixtures) {
			await card.getByRole('button', { name: 'Department', exact: true }).focus();
			await page.mouse.move(0, 0);
			const row = card
				.locator('[data-group-row]:not([inert])')
				.filter({ has: page.getByRole('link', { name: fixture.name, exact: true }) });
			await expect(row).toContainText(fixture.percent + '%');
			const bar = row.locator('.neutral-bar');
			const resting = await geometry(bar);
			expect(resting.support).toBeCloseTo(fixture.percent, 1);
			expect(resting.shares).toHaveLength(fixture.shares.length);
			for (const [index, share] of resting.shares.entries())
				expect(share).toBeCloseTo(fixture.shares[index], 1);

			await bar.hover();
			await expect
				.poll(async () => (await geometry(bar)).segments.map((segment) => segment.color))
				.not.toEqual(resting.segments.map((segment) => segment.color));
			const hovered = await geometry(bar);
			await page.mouse.move(0, 0);
			await row.getByRole('link', { name: fixture.name, exact: true }).focus();
			await page.keyboard.press('Tab');
			await expect(bar.locator('.seg').first()).toBeFocused();
			const focused = await geometry(bar);
			for (const state of [hovered, focused]) {
				expect(state.support).toBeCloseTo(fixture.percent, 1);
				for (const [index, segment] of state.segments.entries()) {
					expect(segment.left).toBeCloseTo(resting.segments[index].left, 1);
					expect(segment.width).toBeCloseTo(resting.segments[index].width, 1);
				}
			}
		}
	});
}
