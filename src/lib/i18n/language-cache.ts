/**
 * The startup hint for the interface language.
 *
 * It holds two deliberately separate things: the confirmed saved preference, which is
 * what the next launch resolves, and the locale this session actually applied, which is
 * display evidence only. The registry read with the dataset is authoritative; this cache
 * may only word the pre-framework splash before that read returns.
 *
 * Keep the key and the checks in step with the inline resolver in `src/app.html`.
 */
import type { LanguagePreference } from '#lib/shared/app-settings.ts';
import type { AppLocale } from './locale.ts';

const languageStorageKey = 'wobble.language';

type CachedLanguage = {
	preference: LanguagePreference;
	appliedLocale: AppLocale;
};

/** Remembers a confirmed preference for the next launch's first paint. */
export function cacheLanguage(preference: LanguagePreference, appliedLocale: AppLocale): void {
	try {
		localStorage.setItem(
			languageStorageKey,
			JSON.stringify({ preference, appliedLocale } satisfies CachedLanguage)
		);
	} catch {
		// Storage can be denied. The registry read still reconciles after load.
	}
}

/**
 * Forgets the startup hint. Restore replaces the registry with another database's, so
 * the previous launch's cached preference must not word the next splash; the restored
 * registry becomes authoritative again after load.
 */
export function clearLanguage(): void {
	try {
		localStorage.removeItem(languageStorageKey);
	} catch {
		// Storage can be denied. The authoritative read still reconciles after load.
	}
}
