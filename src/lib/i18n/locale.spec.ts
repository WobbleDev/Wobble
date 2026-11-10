import { describe, expect, it } from 'vitest';
import {
	explicitLocale,
	isSupportedLocale,
	localeFromPreferredLanguages,
	resolveAppLocale
} from './locale.ts';

describe('localeFromPreferredLanguages', () => {
	it('takes the first supported family and keeps looking past unsupported entries', () => {
		expect(localeFromPreferredLanguages(['fr-CA', 'es-MX', 'en-US'])).toBe('es-419');
		expect(localeFromPreferredLanguages(['fr-CA', 'en-US', 'es-MX'])).toBe('en');
		expect(localeFromPreferredLanguages(['es-419'])).toBe('es-419');
		expect(localeFromPreferredLanguages(['en-GB'])).toBe('en');
	});

	it('falls back to English when no entry is supported or usable', () => {
		expect(localeFromPreferredLanguages([])).toBe('en');
		expect(localeFromPreferredLanguages(['fr', 'pt-BR', 'de'])).toBe('en');
		expect(localeFromPreferredLanguages(['', 'not a tag', '??', 'es_'])).toBe('en');
		expect(localeFromPreferredLanguages([42, null, undefined, 'fr'] as unknown as string[])).toBe(
			'en'
		);
	});

	it('ignores malformed entries and still takes a later supported one', () => {
		expect(localeFromPreferredLanguages(['', 'en_US', 'es_419'])).toBe('en');
		expect(localeFromPreferredLanguages([' ', 'es_419'])).toBe('es-419');
	});

	it('is not confused by a longer malformed first segment', () => {
		expect(localeFromPreferredLanguages(['spanish', 'es-MX'])).toBe('es-419');
		expect(localeFromPreferredLanguages(['english', 'en-US'])).toBe('en');
	});
});

describe('resolveAppLocale', () => {
	it('lets an explicit valid choice override the preferred list', () => {
		expect(resolveAppLocale('en', ['es-MX'])).toBe('en');
		expect(resolveAppLocale('es-419', ['en-US'])).toBe('es-419');
	});

	it('follows the preferred list for system and for a missing or invalid choice', () => {
		expect(resolveAppLocale('system', ['fr-CA', 'es-MX'])).toBe('es-419');
		expect(resolveAppLocale(undefined, ['fr-CA', 'en-US'])).toBe('en');
		expect(resolveAppLocale('es', ['en-US'])).toBe('en');
		expect(resolveAppLocale('en-US', ['es-MX'])).toBe('es-419');
	});

	it('never treats an unsupported stored value as an explicit locale', () => {
		expect(explicitLocale('es')).toBeUndefined();
		expect(explicitLocale('en-US')).toBeUndefined();
		expect(explicitLocale('system')).toBeUndefined();
		expect(explicitLocale('es-419')).toBe('es-419');
		expect(isSupportedLocale('es-419')).toBe(true);
		expect(isSupportedLocale('es')).toBe(false);
	});
});
