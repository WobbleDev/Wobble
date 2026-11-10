import type { Page } from '@playwright/test';

/** Let the browser paint `count` frames: layout, observers and pointer handlers have run. */
export async function nextFrames(page: Page, count = 2): Promise<void> {
	await page.evaluate(
		(frames) =>
			new Promise<void>((resolve) => {
				let left = frames;
				const tick = () => {
					left -= 1;
					if (left <= 0) resolve();
					else requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			}),
		count
	);
}
