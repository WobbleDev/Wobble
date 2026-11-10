<script lang="ts">
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { getContext } from 'svelte';
	import { dataErrorCopy, type DataErrorCopy } from '#lib/client/data-api.ts';
	import { resetWindow } from '#lib/client/tauri-window.ts';
	import { isTauriTransport } from '#lib/client/transport.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { appSettingsContextKey, type AppSettingsContext } from '#lib/shared/app-settings.ts';
	import { m } from '#lib/paraglide/messages.js';
	import DataErrorNotice from '../data-error-notice.svelte';
	import SettingsRow from '../settings-row.svelte';
	import SettingsSwitch from '../settings-switch.svelte';
	import SettingsWell from '../settings-well.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);

	let resettingWindow = $state(false);
	let resetWindowError = $state<DataErrorCopy | null>(null);

	/*
	 * The reset itself belongs to the desktop shell: it clears the saved window state on
	 * disk and moves the window. Outside the shell the well shows a sentence instead.
	 */
	async function resetWindowState(): Promise<void> {
		resettingWindow = true;
		resetWindowError = null;
		try {
			await resetWindow();
		} catch (error) {
			resetWindowError = dataErrorCopy(error, m.settings_data_error_reset_window());
		} finally {
			resettingWindow = false;
		}
	}
</script>

<SettingsWell
	id="general"
	title={m.settings_general_title()}
	description={m.settings_general_description()}
>
	{#if isTauriTransport()}
		<SettingsRow
			id="gen-window"
			title={m.settings_remember_window_title()}
			description={m.settings_remember_window_description()}
		>
			<Button
				type="button"
				variant="ghost"
				class="min-h-tap md:min-h-9"
				disabled={!settings.rememberWindow || resettingWindow}
				onclick={resetWindowState}
			>
				<RotateCcw aria-hidden="true" class="size-4" />
				{m.settings_reset_window()}
			</Button>
			<SettingsSwitch
				checked={settings.rememberWindow}
				onchange={(checked) => void settings.update({ rememberWindow: checked })}
				labelledby="gen-window-title"
			/>
		</SettingsRow>
		{#if resetWindowError}
			<div class="px-6 pb-4"><DataErrorNotice error={resetWindowError} /></div>
		{/if}
	{:else}
		<p class="border-t border-rule px-6 py-4 text-sm text-ink-3">
			{m.settings_window_desktop_only()}
		</p>
	{/if}
</SettingsWell>
