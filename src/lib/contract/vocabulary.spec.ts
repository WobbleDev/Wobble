import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assessedOptions, assessmentOptions } from '#lib/domain-vocabulary.ts';
import {
	dateFormatPreferences,
	defaultAppSettings,
	densityPreferences,
	languagePreferences,
	reduceMotionPreferences,
	textSizePreferences,
	themePreferences,
	timeFormatPreferences
} from '#lib/shared/app/app-settings.ts';
import { readLayoutCss } from '#lib/testing/layout-css.ts';

const golden = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../contract/vocabulary.json', import.meta.url)), 'utf8')
) as {
	assessment: string[];
	theme: string[];
	density: string[];
	reduceMotion: string[];
	textSize: string[];
	dateFormat: string[];
	timeFormat: string[];
	language: string[];
	defaults: Record<string, string | boolean>;
};

const css = readLayoutCss();

describe('golden vocabulary', () => {
	it('matches the assessment list', () => {
		expect([...assessmentOptions]).toEqual(golden.assessment);
	});

	it('derives the assessed list as the golden scale without Unassessed', () => {
		expect([...assessedOptions]).toEqual(golden.assessment.slice(1));
	});

	it('matches every registered choice list', () => {
		expect([...themePreferences]).toEqual(golden.theme);
		expect([...densityPreferences]).toEqual(golden.density);
		expect([...reduceMotionPreferences]).toEqual(golden.reduceMotion);
		expect([...textSizePreferences]).toEqual(golden.textSize);
		expect([...dateFormatPreferences]).toEqual(golden.dateFormat);
		expect([...timeFormatPreferences]).toEqual(golden.timeFormat);
		expect([...languagePreferences]).toEqual(golden.language);
	});

	it('matches the golden defaults', () => {
		expect(defaultAppSettings).toEqual(golden.defaults);
	});

	it('declares each assessment colour token once per palette and theme block', () => {
		for (const option of golden.assessment) {
			const name = option.toLowerCase();
			const declarations = css.match(new RegExp(`(?<![\\w-])--assess-${name}\\s*:`, 'g')) ?? [];
			// Default light + dark, then the opt-in color-blind light + dark palette.
			expect(declarations, `--assess-${name}`).toHaveLength(4);
		}
	});
});

const messagesRoot = fileURLToPath(new URL('../../../messages/', import.meta.url));

function collectStrings(value: unknown, parts: string[]): void {
	if (typeof value === 'string') parts.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, parts);
	else if (value && typeof value === 'object') {
		for (const item of Object.values(value)) collectStrings(item, parts);
	}
}

/** Every user-facing string of one locale, keyed by message key; plural variants are joined. */
function messageTexts(locale: 'en' | 'es-419'): Map<string, string> {
	const texts = new Map<string, string>();
	const add = (catalog: unknown) => {
		if (!catalog || typeof catalog !== 'object') return;
		for (const [key, value] of Object.entries(catalog)) {
			if (key === '$schema') continue;
			const parts: string[] = [];
			collectStrings(value, parts);
			texts.set(key, parts.join('\n'));
		}
	};
	add(JSON.parse(readFileSync(join(messagesRoot, `${locale}.json`), 'utf8')));
	const catalogDir = join(messagesRoot, locale);
	for (const file of readdirSync(catalogDir).filter((name) => name.endsWith('.json'))) {
		add(JSON.parse(readFileSync(join(catalogDir, file), 'utf8')));
	}
	return texts;
}

const en = messageTexts('en');
const es = messageTexts('es-419');

/*
 * Import copy may still speak of contacts, and only those named keys may. Worker
 * vocabulary may not; nor may any of the other retired terms below.
 */
const contactAllowlist = new Set([
	'onboarding_import_contacts',
	'onboarding_setup_description',
	'overview_support_empty',
	'shell_import_contacts'
]);
const contactAllowed = (key: string) =>
	contactAllowlist.has(key) || key.startsWith('workers_import_');

/** The two surviving key names that contain "password"; both values say passphrase. */
const passwordKeyAllowlist = new Set(['settings_change_password', 'settings_password']);

describe('message vocabulary', () => {
	it('keeps retired Worker terms out of every English value', () => {
		const forbidden = [
			['record', /record/i],
			['draft update/base/surface', /draft (update|base|surface)/i],
			['password', /password/i],
			['Abbreviation', /abbreviat/i],
			['licence', /licence/i],
			['neighbourhood', /neighbourhood/i],
			['linked', /\blinked\b/i]
		] as const;
		for (const [key, text] of en) {
			if (!contactAllowed(key)) expect(text, `${key}: contacts`).not.toMatch(/\bcontacts\b/i);
			for (const [term, pattern] of forbidden) {
				expect(text, `${key}: ${term}`).not.toMatch(pattern);
			}
		}
	});

	it('keeps only the two password key names that are still used', () => {
		for (const key of en.keys()) {
			if (/password/i.test(key)) expect(passwordKeyAllowlist.has(key), key).toBe(true);
		}
	});

	it('has no redundant page subtitles', () => {
		const subtitles = /^page_.*_subtitle$/;
		expect([...en.keys()].filter((key) => subtitles.test(key))).toEqual([]);
		expect([...es.keys()].filter((key) => subtitles.test(key))).toEqual([]);
	});

	it('uses the singular Worker in every _one variant', () => {
		for (const [key, text] of en) {
			if (key.endsWith('_one')) expect(text, key).not.toMatch(/\bworkers\b/);
		}
	});

	it('speaks Value rather than Option or Answer in Configuration and Views', () => {
		for (const [key, text] of en) {
			if (!/^(configuration_|views_)/.test(key)) continue;
			const wording = text.replace(/\{[^}]+\}/g, ' ');
			expect(wording, `${key}: option/answer`).not.toMatch(/\b(options?|answers?)\b/i);
		}
		for (const [key, text] of es) {
			if (!/^(configuration_|views_)/.test(key)) continue;
			const wording = text.replace(/\{[^}]+\}/g, ' ');
			expect(wording, `${key}: opción/respuesta`).not.toMatch(
				/\b(opci[oó]n(?:es)?|respuestas?)\b/i
			);
		}
	});

	it('keeps the agreed glossary term in each locale', () => {
		expect(en.get('configuration_abbreviation_aria')).toBe('Short form of {name}');
		expect(en.get('configuration_column_abbreviation')).toBe('Short form');
		expect(en.get('overview_show_dashboard')).toBe('Show Overview');
		expect(es.get('overview_show_dashboard')).toBe('Mostrar Resumen');
		expect(en.get('views_problem_answer')).toBe('Value no longer exists in {attribute}');
		expect(es.get('views_problem_answer')).toBe('El valor ya no existe en {attribute}');
		expect(en.get('mapping_key_shown_one')).toContain('{count} worker');
		expect(en.get('mapping_key_hidden_one')).toContain('{count} worker');
		expect(en.get('mapping_scope_isolated')).toContain('{total} workers');
		expect(es.get('mapping_scope_isolated')).toContain('{total} trabajadores');
		expect(en.get('workers_relationships_count')).toContain('relationship');
		expect(en.get('workers_empty_body')).not.toMatch(/record/i);
	});

	it('never says Agitaciones in Spanish', () => {
		for (const [key, text] of es) expect(text, key).not.toMatch(/agitaci/i);
	});

	it('keeps the en and es-419 catalogs in key parity', () => {
		expect([...es.keys()].sort()).toEqual([...en.keys()].sort());
	});
});
