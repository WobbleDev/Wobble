import type { AppSettings } from '#lib/shared/app-settings.ts';

/** Keep this key in step with the inline first-paint script in `src/app.html`. */
const appearanceStorageKey = 'wobble.appearance';

/** Remembers the appearance for the next first paint. */
export function cacheAppearance(settings: AppSettings): void {
	try {
		localStorage.setItem(appearanceStorageKey, JSON.stringify(settings));
	} catch {
		// Storage can be denied; the server's settings still reconcile after load.
	}
}
