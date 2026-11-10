/**
 * The one place the applied interface locale is resolved and frozen.
 *
 * Wobble resolves its locale once per launch: an explicit saved choice wins, a saved
 * `system` choice walks the WebView's ordered preferred languages, and English is the
 * safe fallback. The result is written to Paraglide's global locale and the document's
 * `lang`/`dir`; nothing else in the app detects or persists a locale. A saved preference
 * therefore changes the next launch, never the running session.
 */
import { getLocale, getTextDirection, setLocale } from '#lib/paraglide/runtime.js';
import type { LanguagePreference } from '#lib/shared/app-settings.ts';

/** The catalogs this release ships, in the order the registry lists them. */
export type AppLocale = 'en' | 'es-419';

/** A development-only expanded pseudo-locale; never a selectable release language. */
const stressLocale = 'en-XA' as const;
type StressLocale = typeof stressLocale;

/** True only when the build or test run explicitly asks for the stress locale. */
const stressLocaleEnabled = import.meta.env.VITE_WOBBLE_PSEUDO_LOCALE === '1';

/** The installed BCP-47 tags offered to formatters and collators, best first. */
export type PreferredLanguages = readonly string[];

export function isSupportedLocale(value: unknown): value is AppLocale {
	return value === 'en' || value === 'es-419';
}

/** An explicit saved choice, or undefined when the choice is `system` or unrecognized. */
export function explicitLocale(preference: unknown): AppLocale | undefined {
	return isSupportedLocale(preference) ? preference : undefined;
}

/**
 * The language family of one preferred-language entry, or undefined for a malformed or
 * unsupported entry. A regional variant keeps its family: es-MX is still Spanish.
 */
function supportedFamily(tag: unknown): AppLocale | undefined {
	if (typeof tag !== 'string') return undefined;

	const trimmed = tag.trim().replaceAll('_', '-');
	if (trimmed.length === 0 || trimmed.length > 64) return undefined;

	// Every subtag must be a non-empty BCP-47-shaped token, so an empty trailing
	// segment such as "es-" is malformed rather than Spanish.
	const parts = trimmed.split('-');
	if (parts.some((part) => !/^[a-zA-Z0-9]{1,8}$/.test(part))) return undefined;

	const language = parts[0]?.toLowerCase() ?? '';
	if (!/^[a-z]{2,3}$/.test(language)) return undefined;

	if (language === 'es') return 'es-419';
	if (language === 'en') return 'en';
	return undefined;
}

/**
 * Walk ordered preferences and return the first supported language family. Unsupported
 * and malformed entries are skipped, so a later supported entry still wins.
 */
export function localeFromPreferredLanguages(preferred: PreferredLanguages): AppLocale {
	for (const tag of preferred) {
		const locale = supportedFamily(tag);
		if (locale) return locale;
	}
	return 'en';
}

/**
 * The applied locale for one launch. `preference` is the validated registry value; any
 * missing or invalid stored choice follows the registry default (`system`).
 */
export function resolveAppLocale(
	preference: LanguagePreference | unknown,
	preferred: PreferredLanguages
): AppLocale {
	return explicitLocale(preference) ?? localeFromPreferredLanguages(preferred);
}

/**
 * The WebView's ordered preferences. Reading is best-effort: a denied or unusual
 * environment falls back to the singular `navigator.language`, then to English.
 */
export function readPreferredLanguages(): string[] {
	if (typeof navigator === 'undefined') return [];

	const languages = navigator.languages;
	if (Array.isArray(languages) && languages.length > 0) {
		return [...languages];
	}
	return typeof navigator.language === 'string' ? [navigator.language] : [];
}

/**
 * Freeze the locale for this session and synchronize document metadata. This is called
 * by the layout's load, once with the system fallback and again when authoritative
 * Settings return; it never reloads the document.
 */
export function applyAppLocale(locale: AppLocale | StressLocale): AppLocale | StressLocale {
	setLocale(locale, { reload: false });

	if (typeof document !== 'undefined') {
		document.documentElement.lang = locale;
		document.documentElement.dir = getTextDirection(locale);
	}

	return locale;
}

/** The locale frozen for this launch. */
export function appliedLocale(): AppLocale {
	const locale = getLocale();
	return isSupportedLocale(locale) ? locale : 'en';
}

/** The locale a launch applies; the stress build overrides the normal resolution. */
export function launchLocale(
	preference: LanguagePreference | unknown,
	preferred: PreferredLanguages
): AppLocale | StressLocale {
	return stressLocaleEnabled ? stressLocale : resolveAppLocale(preference, preferred);
}
