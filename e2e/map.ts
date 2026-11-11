import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';

/** Shared CI runners can take well over the 5s expect default to measure and fit a large map. */
const MAP_READY_TIMEOUT_MS = 30_000;

/** Wait for the first measured arrangement and camera fit, not a fixed timer. */
export async function waitForMapReady(
	page: Page,
	timeout: number = MAP_READY_TIMEOUT_MS
): Promise<void> {
	await expect(page.getByTestId('relationship-map-canvas')).toHaveAttribute(
		'data-map-ready',
		'true',
		{ timeout }
	);
}

/**
 * Wait until a gesture can reach the map: the drawing is ready *and* the start-up
 * screen is gone. The splash (src/app.html) is a fixed, full-viewport layer held a
 * second after navigation, and it keeps the pointer — a press that arrives while it
 * is up lands on the splash, not on a dot, hull or the surface. Geometry reads use
 * `waitForMapReady`; anything that moves or selects uses this.
 */
export async function waitForMapInteraction(page: Page, timeout?: number): Promise<void> {
	await waitForMapReady(page, timeout);
	await expect(page.locator('#splash')).toHaveCount(0, { timeout });
}

/**
 * Read a measurement until two reads 100ms apart agree: the geometry has stopped
 * moving. Use it after a drag, resize or re-layout, which the ready signal (first
 * mount only) does not cover.
 */
export async function settled<T>(read: () => Promise<T>): Promise<T> {
	let previous: string | undefined;
	let latest!: T;
	await expect
		.poll(
			async () => {
				latest = await read();
				const key = JSON.stringify(latest);
				const stable = key === previous;
				previous = key;
				return stable;
			},
			{ intervals: [100], message: 'the map geometry never settled' }
		)
		.toBe(true);
	return latest;
}

/** Wait for an explicitly identified operation and its fully applied camera/scene. */
export async function waitForSceneReady(
	page: Page,
	expected: { scene?: string; manual?: number; cameraAfter?: number } = {},
	timeout?: number
): Promise<void> {
	const surface = page.getByTestId('relationship-map-surface');
	if (expected.scene !== undefined)
		await expect(surface).toHaveAttribute('data-scene-revision', expected.scene, { timeout });
	if (expected.manual !== undefined)
		await expect(surface).toHaveAttribute('data-manual-revision', String(expected.manual), {
			timeout
		});
	if (expected.cameraAfter !== undefined)
		await expect
			.poll(async () => Number(await surface.getAttribute('data-camera-revision')), { timeout })
			.toBeGreaterThan(expected.cameraAfter);
	await expect(surface).not.toHaveAttribute('data-scene-error', /.+/, { timeout });
	await expect(surface).toHaveAttribute('data-scene-ready', 'true', { timeout });
	await expect(surface).toHaveAttribute('data-camera-idle', 'true', { timeout });
}
