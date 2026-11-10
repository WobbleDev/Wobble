<script lang="ts">
	import { getContext } from 'svelte';
	import {
		appSettingsContextKey,
		isDensityPreference,
		type AppSettingsContext
	} from '#lib/shared/app-settings.ts';
	import { m } from '#lib/paraglide/messages.js';
	import ChoiceSet from '../choice-set.svelte';
	import SettingsWell from '../settings-well.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);

	const densityOptions = $derived([
		{
			value: 'compact',
			label: m.settings_density_compact(),
			key: m.settings_density_compact_key()
		},
		{
			value: 'standard',
			label: m.settings_density_standard(),
			key: m.settings_density_standard_key()
		},
		{
			value: 'comfortable',
			label: m.settings_density_comfortable(),
			key: m.settings_density_comfortable_key()
		}
	] as const);
</script>

<SettingsWell
	id="density"
	title={m.settings_density_title()}
	description={m.settings_density_description()}
>
	<ChoiceSet
		id="density"
		name={m.settings_density_title()}
		options={densityOptions}
		selected={settings.density}
		apply={(value) => {
			if (isDensityPreference(value)) void settings.update({ density: value });
		}}
	/>
</SettingsWell>
