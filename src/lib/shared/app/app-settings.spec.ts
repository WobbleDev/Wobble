import { describe, expect, it } from 'vitest';
import {
	defaultAppSettings,
	isAppSettings,
	isColorBlindAssessments,
	isDateFormatPreference,
	isDensityPreference,
	isIncreaseContrast,
	isReduceMotionPreference,
	isRememberWindow,
	isTextSizePreference,
	isThemePreference,
	isTimeFormatPreference,
	isLanguagePreference,
	themePreferences,
	type AppSettings
} from './app-settings.ts';

const settings: AppSettings = {
	theme: 'dark',
	density: 'compact',
	reduceMotion: 'reduce',
	increaseContrast: true,
	colorBlindAssessments: true,
	textSize: '125',
	rememberWindow: false,
	dateFormat: 'iso',
	timeFormat: '24',
	language: 'es-419'
};

describe('the defaults', () => {
	it('are the values a fresh installation and a reset use', () => {
		expect(defaultAppSettings).toEqual({
			theme: 'system',
			density: 'standard',
			reduceMotion: 'system',
			increaseContrast: false,
			colorBlindAssessments: false,
			textSize: '100',
			rememberWindow: true,
			dateFormat: 'system',
			timeFormat: 'system',
			language: 'system'
		});
		expect(isAppSettings(defaultAppSettings)).toBe(true);
	});
});

describe('the per-key guards', () => {
	it('accept only the registered choices, matched exactly', () => {
		for (const theme of themePreferences) expect(isThemePreference(theme)).toBe(true);
		expect(isThemePreference('Dark')).toBe(false);
		expect(isThemePreference(' dark ')).toBe(false);
		expect(isThemePreference(42)).toBe(false);
		expect(isThemePreference(null)).toBe(false);

		for (const density of ['compact', 'standard', 'comfortable']) {
			expect(isDensityPreference(density)).toBe(true);
		}
		expect(isDensityPreference('cozy')).toBe(false);

		for (const motion of ['system', 'reduce', 'full']) {
			expect(isReduceMotionPreference(motion)).toBe(true);
		}
		expect(isReduceMotionPreference('less')).toBe(false);

		for (const size of ['100', '110', '125', '150']) {
			expect(isTextSizePreference(size)).toBe(true);
		}
		expect(isTextSizePreference(125)).toBe(false);
		expect(isTextSizePreference('115')).toBe(false);

		for (const format of ['system', 'dmy', 'mdy', 'iso']) {
			expect(isDateFormatPreference(format)).toBe(true);
		}
		expect(isDateFormatPreference('ymd')).toBe(false);

		for (const format of ['system', '12', '24']) {
			expect(isTimeFormatPreference(format)).toBe(true);
		}
		expect(isTimeFormatPreference(12)).toBe(false);

		for (const language of ['system', 'en', 'es-419']) {
			expect(isLanguagePreference(language)).toBe(true);
		}
		expect(isLanguagePreference('es')).toBe(false);
		expect(isLanguagePreference('en-US')).toBe(false);
	});

	it('accept only a real boolean for an on/off setting', () => {
		for (const guard of [isIncreaseContrast, isColorBlindAssessments, isRememberWindow]) {
			expect(guard(true)).toBe(true);
			expect(guard(false)).toBe(true);
			expect(guard('true')).toBe(false);
			expect(guard(1)).toBe(false);
			expect(guard(null)).toBe(false);
		}
	});
});

describe('isAppSettings', () => {
	it('accepts a full settings object and drops nothing', () => {
		expect(isAppSettings(settings)).toBe(true);
	});

	it('rejects a record missing any registered key', () => {
		for (const key of Object.keys(settings) as (keyof AppSettings)[]) {
			const partial: Record<string, unknown> = { ...settings };
			delete partial[key];
			expect(isAppSettings(partial), key).toBe(false);
		}
	});

	it('rejects a value the key does not allow', () => {
		expect(isAppSettings({ ...settings, theme: 'sepia' })).toBe(false);
		expect(isAppSettings({ ...settings, increaseContrast: 'true' })).toBe(false);
		expect(isAppSettings({ ...settings, textSize: 125 })).toBe(false);
		expect(isAppSettings({ ...settings, rememberWindow: undefined })).toBe(false);
	});

	it('rejects anything that is not a plain record', () => {
		for (const value of [null, undefined, 'settings', 42, [], [settings]]) {
			expect(isAppSettings(value)).toBe(false);
		}
	});
});
