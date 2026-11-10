<script lang="ts">
	import { getContext } from 'svelte';
	import {
		appSettingsContextKey,
		isThemePreference,
		type AppSettingsContext
	} from '#lib/shared/app-settings.ts';
	import { m } from '#lib/paraglide/messages.js';
	import ChoiceSet from '../choice-set.svelte';
	import SettingsWell from '../settings-well.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);

	const themeOptions = $derived([
		{ value: 'system', label: m.settings_theme_system(), key: m.settings_theme_system_key() },
		{ value: 'light', label: m.settings_theme_light(), key: m.settings_theme_light_key() },
		{ value: 'dark', label: m.settings_theme_dark(), key: m.settings_theme_dark_key() }
	] as const);
</script>

<SettingsWell
	id="theme"
	title={m.settings_theme_title()}
	description={m.settings_theme_description()}
>
	<ChoiceSet
		id="theme"
		name={m.settings_theme_title()}
		options={themeOptions}
		selected={settings.theme}
		apply={(value) => {
			if (isThemePreference(value)) void settings.update({ theme: value });
		}}
	/>
</SettingsWell>
