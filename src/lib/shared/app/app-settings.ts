/**
 * The installation-wide settings registry: every key, its choices or boolean type, the
 * guards that check an untrusted value before anything trusts it, and the defaults.
 * Keep this shape in step with the Rust registry in crates/wobble-core/src/app_settings.rs.
 */
export const themePreferences = ['system', 'light', 'dark'] as const;
export const densityPreferences = ['compact', 'standard', 'comfortable'] as const;
export const reduceMotionPreferences = ['system', 'reduce', 'full'] as const;
export const textSizePreferences = ['100', '110', '125', '150'] as const;
export const dateFormatPreferences = ['system', 'dmy', 'mdy', 'iso'] as const;
export const timeFormatPreferences = ['system', '12', '24'] as const;
export const languagePreferences = ['system', 'en', 'es-419'] as const;

export type ThemePreference = (typeof themePreferences)[number];
export type DensityPreference = (typeof densityPreferences)[number];
export type ReduceMotionPreference = (typeof reduceMotionPreferences)[number];
export type TextSizePreference = (typeof textSizePreferences)[number];
export type DateFormatPreference = (typeof dateFormatPreferences)[number];
export type TimeFormatPreference = (typeof timeFormatPreferences)[number];
export type LanguagePreference = (typeof languagePreferences)[number];

/** Every registered setting, typed by its value. */
export type AppSettings = {
	theme: ThemePreference;
	density: DensityPreference;
	reduceMotion: ReduceMotionPreference;
	increaseContrast: boolean;
	colorBlindAssessments: boolean;
	textSize: TextSizePreference;
	rememberWindow: boolean;
	dateFormat: DateFormatPreference;
	timeFormat: TimeFormatPreference;
	language: LanguagePreference;
};

/** One setting per update; the Rust core accepts exactly one key per PUT. */
export type AppSettingsUpdate =
	| { theme: ThemePreference }
	| { density: DensityPreference }
	| { reduceMotion: ReduceMotionPreference }
	| { increaseContrast: boolean }
	| { colorBlindAssessments: boolean }
	| { textSize: TextSizePreference }
	| { rememberWindow: boolean }
	| { dateFormat: DateFormatPreference }
	| { timeFormat: TimeFormatPreference }
	| { language: LanguagePreference };

/** What the app shows before it has read anything, and what reset returns. */
export const defaultAppSettings: AppSettings = {
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
};

export const appSettingsContextKey = Symbol('app-settings');

export type AppSettingsContext = AppSettings & {
	isDark: boolean;
	saving: boolean;
	saveError: string;
	syncError: boolean;
	update(update: AppSettingsUpdate): Promise<void>;
	reset(): Promise<void>;
};

function oneOf<T extends string>(choices: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && choices.some((choice) => choice === value);
}

export function isThemePreference(value: unknown): value is ThemePreference {
	return oneOf(themePreferences, value);
}

export function isDensityPreference(value: unknown): value is DensityPreference {
	return oneOf(densityPreferences, value);
}

export function isReduceMotionPreference(value: unknown): value is ReduceMotionPreference {
	return oneOf(reduceMotionPreferences, value);
}

export function isIncreaseContrast(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

export function isColorBlindAssessments(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

export function isTextSizePreference(value: unknown): value is TextSizePreference {
	return oneOf(textSizePreferences, value);
}

export function isRememberWindow(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

export function isDateFormatPreference(value: unknown): value is DateFormatPreference {
	return oneOf(dateFormatPreferences, value);
}

export function isTimeFormatPreference(value: unknown): value is TimeFormatPreference {
	return oneOf(timeFormatPreferences, value);
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
	return oneOf(languagePreferences, value);
}

/** Validates every registered key, so an older or malformed reply is rejected whole. */
export function isAppSettings(value: unknown): value is AppSettings {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

	return (
		isThemePreference(Reflect.get(value, 'theme')) &&
		isDensityPreference(Reflect.get(value, 'density')) &&
		isReduceMotionPreference(Reflect.get(value, 'reduceMotion')) &&
		isIncreaseContrast(Reflect.get(value, 'increaseContrast')) &&
		isColorBlindAssessments(Reflect.get(value, 'colorBlindAssessments')) &&
		isTextSizePreference(Reflect.get(value, 'textSize')) &&
		isRememberWindow(Reflect.get(value, 'rememberWindow')) &&
		isDateFormatPreference(Reflect.get(value, 'dateFormat')) &&
		isTimeFormatPreference(Reflect.get(value, 'timeFormat')) &&
		isLanguagePreference(Reflect.get(value, 'language'))
	);
}
