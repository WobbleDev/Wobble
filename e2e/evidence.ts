/**
 * Screenshot evidence routing. Every run writes its routine image under the test's
 * own output directory; with WOBBLE_CAPTURE=1 the same image is copied into the
 * ticket's tracked historical evidence directory. Nothing here writes there unless
 * the opt-in is set.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

/** The routine screenshot path for a test, with its image directory created. */
export function routineImagePath(testInfo: TestInfo, name: string): string {
	const file = testInfo.outputPath('images', name);
	mkdirSync(dirname(file), { recursive: true });
	return file;
}

/**
 * Screenshots the drawing into the run's own directory and, when WOBBLE_CAPTURE=1,
 * takes the same screenshot again into the tracked historical evidence directory.
 */
export async function captureRoutineImage(
	page: Page,
	testInfo: TestInfo,
	name: string,
	historicalDirectory: string
): Promise<void> {
	await page.screenshot({ path: routineImagePath(testInfo, name) });
	if (process.env.WOBBLE_CAPTURE !== '1') return;
	mkdirSync(historicalDirectory, { recursive: true });
	await page.screenshot({ path: resolve(historicalDirectory, name) });
}
