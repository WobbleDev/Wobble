<script lang="ts">
	import { getContext } from 'svelte';
	import {
		appSettingsContextKey,
		isReduceMotionPreference,
		isTextSizePreference,
		type AppSettingsContext
	} from '#lib/shared/app-settings.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { Choice } from '../choice.ts';
	import Picker from '../picker.svelte';
	import SettingsRow from '../settings-row.svelte';
	import SettingsSwitch from '../settings-switch.svelte';
	import SettingsWell from '../settings-well.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);

	const motionOptions = $derived<Choice[]>([
		{ value: 'system', label: m.settings_motion_system() },
		{ value: 'reduce', label: m.settings_motion_reduce() },
		{ value: 'full', label: m.settings_motion_full() }
	]);
	const textSizes = $derived<Choice[]>([
		{ value: '100', label: m.settings_text_size_100() },
		{ value: '110', label: m.settings_text_size_110() },
		{ value: '125', label: m.settings_text_size_125() },
		{ value: '150', label: m.settings_text_size_150() }
	]);
</script>

<SettingsWell
	id="accessibility"
	title={m.settings_accessibility_title()}
	description={m.settings_accessibility_description()}
>
	<SettingsRow
		id="a11y-motion"
		title={m.settings_reduce_motion_title()}
		description={m.settings_reduce_motion_description()}
	>
		<Picker
			rowId="a11y-motion"
			choices={motionOptions}
			value={settings.reduceMotion}
			onChange={(v) => {
				if (isReduceMotionPreference(v)) void settings.update({ reduceMotion: v });
			}}
		/>
	</SettingsRow>
	<SettingsRow
		id="a11y-contrast"
		title={m.settings_contrast_title()}
		description={m.settings_contrast_description()}
	>
		<SettingsSwitch
			checked={settings.increaseContrast}
			onchange={(checked) => void settings.update({ increaseContrast: checked })}
			labelledby="a11y-contrast-title"
		/>
	</SettingsRow>
	<SettingsRow
		id="a11y-colorblind"
		title={m.settings_colorblind_title()}
		description={m.settings_colorblind_description()}
	>
		<SettingsSwitch
			checked={settings.colorBlindAssessments}
			onchange={(checked) => void settings.update({ colorBlindAssessments: checked })}
			labelledby="a11y-colorblind-title"
		/>
	</SettingsRow>
	<SettingsRow
		id="a11y-text"
		title={m.settings_text_size_title()}
		description={m.settings_text_size_description()}
	>
		<Picker
			rowId="a11y-text"
			choices={textSizes}
			value={settings.textSize}
			onChange={(v) => {
				if (isTextSizePreference(v)) void settings.update({ textSize: v });
			}}
			width="sm:w-44"
		/>
	</SettingsRow>
</SettingsWell>
