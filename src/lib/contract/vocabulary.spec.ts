import { readFileSync } from 'node:fs';
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
} from '#lib/shared/app-settings.ts';

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

const css = readFileSync(
	fileURLToPath(new URL('../../routes/layout.css', import.meta.url)),
	'utf8'
);

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
