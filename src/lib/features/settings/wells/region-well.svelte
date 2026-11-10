<script lang="ts">
	import { getContext } from 'svelte';
	import {
		appSettingsContextKey,
		isDateFormatPreference,
		isLanguagePreference,
		isTimeFormatPreference,
		type AppSettingsContext
	} from '#lib/shared/app-settings.ts';
	import { formatTimestamp } from '#lib/shared/format.ts';
	import { appliedLocale, readPreferredLanguages, resolveAppLocale } from '#lib/i18n/locale.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { Choice } from '../choice.ts';
	import Picker from '../picker.svelte';
	import SettingsRow from '../settings-row.svelte';
	import SettingsWell from '../settings-well.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);

	/* The two shipped language names stay in their own language, so a reader who
	   cannot read the current interface can still recognize one. */
	const languages: Choice[] = $derived([
		{ value: 'system', label: m.settings_language_system() },
		{ value: 'en', label: 'English' },
		{ value: 'es-419', label: 'Español (Latinoamérica)' }
	]);

	const preferredLanguages = readPreferredLanguages();
	const savedLocale = $derived(resolveAppLocale(settings.language, preferredLanguages));
	const restartLanguage = $derived(
		!settings.saving && savedLocale !== appliedLocale()
			? savedLocale === 'es-419'
				? 'Español (Latinoamérica)'
				: 'English'
			: ''
	);
	const dateFormats = $derived<Choice[]>([
		{ value: 'system', label: m.settings_same_as_computer() },
		{ value: 'dmy', label: m.settings_date_dmy() },
		{ value: 'mdy', label: m.settings_date_mdy() },
		{ value: 'iso', label: m.settings_date_iso() }
	]);
	const timeFormats = $derived<Choice[]>([
		{ value: 'system', label: m.settings_same_as_computer() },
		{ value: '12', label: m.settings_time_12() },
		{ value: '24', label: m.settings_time_24() }
	]);

	/* The sample is a real Note time, formatted the way the saved settings say. */
	const sampleTimestamp = $derived(
		formatTimestamp(new Date().toISOString(), {
			dateFormat: settings.dateFormat,
			timeFormat: settings.timeFormat
		})
	);
</script>

<SettingsWell
	id="region"
	title={m.settings_region_title()}
	description={m.settings_language_region_description()}
>
	<SettingsRow
		id="reg-language"
		title={m.settings_language_title()}
		description={m.settings_language_description()}
	>
		<Picker
			rowId="reg-language"
			choices={languages}
			value={settings.language}
			onChange={(v) => {
				if (isLanguagePreference(v)) void settings.update({ language: v });
			}}
			width="sm:w-64"
		/>
	</SettingsRow>
	{#if restartLanguage}
		<p role="status" class="border-t border-rule px-6 py-3 text-sm text-ink-2">
			{m.settings_language_restart({ language: restartLanguage })}
		</p>
	{/if}
	<SettingsRow id="reg-date" title={m.settings_date_format_title()}>
		<Picker
			rowId="reg-date"
			choices={dateFormats}
			value={settings.dateFormat}
			onChange={(v) => {
				if (isDateFormatPreference(v)) void settings.update({ dateFormat: v });
			}}
			width="sm:w-56"
		/>
	</SettingsRow>
	<SettingsRow id="reg-time" title={m.settings_time_format_title()}>
		<Picker
			rowId="reg-time"
			choices={timeFormats}
			value={settings.timeFormat}
			onChange={(v) => {
				if (isTimeFormatPreference(v)) void settings.update({ timeFormat: v });
			}}
			width="sm:w-56"
		/>
	</SettingsRow>
	<div class="border-t border-rule px-6 py-3">
		<p class="text-sm text-ink-3" aria-live="polite">
			{m.settings_region_sample({ timestamp: sampleTimestamp })}
		</p>
	</div>
</SettingsWell>
