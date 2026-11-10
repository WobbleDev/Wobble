import { error as httpError } from '@sveltejs/kit';
import { startupStatus } from '#lib/shell/startup-status.ts';
import { m } from '#lib/paraglide/messages.js';
import type { LayoutLoad } from './$types';
import { getBootStatus } from '#lib/client/boot-api.ts';
import { defaultAppSettings } from '#lib/shared/app-settings.ts';
import { getWorksiteDataset, takePrimedDataset } from '#lib/client/dataset-api.ts';
import { initApiTransport } from '#lib/client/transport.ts';
import { showWindowAfterFirstPaint } from '#lib/client/tauri-window.ts';
import {
	applyAppLocale,
	isSupportedLocale,
	launchLocale,
	readPreferredLanguages
} from '#lib/i18n/locale.ts';
import { cacheLanguage } from '#lib/i18n/language-cache.ts';
import type { LanguagePreference } from '#lib/shared/app-settings.ts';

let confirmedLocale: ReturnType<typeof launchLocale> | undefined;

/** Data refreshes update the next-launch hint, never the running document's locale. */
function confirmSavedLocale(preference: LanguagePreference, preferredLanguages: string[]): void {
	const locale = (confirmedLocale ??= applyAppLocale(launchLocale(preference, preferredLanguages)));
	if (isSupportedLocale(locale)) cacheLanguage(preference, locale);
}

// The Tauri shell has no server: every load runs in the webview and reads the
// dataset endpoint directly, with the Active Worksite header from client storage.
export const ssr = false;

export const load: LayoutLoad = async () => {
	initApiTransport();
	// Show the window on the start-up screen (app.html) rather than waiting for the
	// dataset: the window starts hidden so it is never seen blank.
	void showWindowAfterFirstPaint().catch((error) => {
		console.error('Could not show the window.', error);
	});

	/* Freeze the applied locale before any translated UI renders. The system fallback
	   is applied first so a failed dataset read still has a usable language; the
	   authoritative Settings then decide the launch's locale once they arrive. */
	const preferredLanguages = readPreferredLanguages();
	if (confirmedLocale === undefined) {
		applyAppLocale(launchLocale('system', preferredLanguages));
	}

	try {
		const boot = await getBootStatus();
		if (boot.state !== 'open') {
			takePrimedDataset(); // Discard any pre-lock in-memory snapshot.
			return {
				boot,
				worksite: null,
				worksites: [],
				workers: [],
				attributes: [],
				agitations: [],
				languages: [],
				settings: { ...defaultAppSettings }
			};
		}
		const dataset = takePrimedDataset();
		if (dataset) {
			confirmSavedLocale(dataset.settings.language, preferredLanguages);
			return { ...dataset, boot };
		}
		const loaded = await getWorksiteDataset();
		confirmSavedLocale(loaded.settings.language, preferredLanguages);
		return { ...loaded, boot };
	} catch (error: unknown) {
		throw httpError(startupStatus(error), m.error_start_body());
	}
};
