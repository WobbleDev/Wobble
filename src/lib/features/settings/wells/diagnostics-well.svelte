<script lang="ts">
	import { onDestroy } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import { dataErrorCopy, type DataErrorCopy } from '#lib/client/data-api.ts';
	import { getRecentLogs, revealLogFolder } from '#lib/client/logs-api.ts';
	import { isTauriTransport } from '#lib/client/transport.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { CopyFeedback } from '../copy-feedback.svelte.ts';
	import DataErrorNotice from '../data-error-notice.svelte';
	import { diagnosticText, type RuntimeReading } from '../runtime-details.ts';
	import SettingsRow from '../settings-row.svelte';
	import SettingsWell from '../settings-well.svelte';

	let { runtime }: { runtime: RuntimeReading } = $props();

	/* Copy reads the running identity, so it waits for the read and stays off when it failed. */
	const canCopy = $derived(!runtime.loading && runtime.error === null);

	const copy = new CopyFeedback();
	const copyLogs = new CopyFeedback();
	onDestroy(() => {
		copy.dispose();
		copyLogs.dispose();
	});

	let logNotice = $state('');
	let logError = $state<DataErrorCopy | null>(null);

	/* The core reads its own log, so what lands on the clipboard is exactly what the file holds. */
	async function copyRecentLogs(): Promise<void> {
		logNotice = '';
		logError = null;
		try {
			const { lines } = await getRecentLogs();
			if (lines.length === 0) {
				logNotice = m.settings_logs_empty();
				return;
			}
			await copyLogs.copy(lines.join('\n'));
		} catch (error) {
			logError = dataErrorCopy(error, m.settings_logs_error());
		}
	}

	async function openLogFolder(): Promise<void> {
		logError = null;
		try {
			await revealLogFolder();
		} catch (error) {
			logError = dataErrorCopy(error, m.settings_data_error_show_log());
		}
	}
</script>

<SettingsWell
	id="diagnostics"
	title={m.settings_diagnostics_title()}
	description={m.settings_diagnostics_description()}
>
	<SettingsRow
		id="dx-copy"
		title={m.settings_copy_diagnostics_title()}
		description={m.settings_copy_diagnostics_description()}
	>
		<Button
			type="button"
			variant="outline"
			class="min-h-tap md:min-h-9"
			disabled={!canCopy}
			onclick={() => void copy.copy(diagnosticText(runtime.value, m.settings_unavailable_value()))}
		>
			{#if copy.copied}
				<Check aria-hidden="true" class="size-4" />
				{m.settings_copied()}
			{:else}
				<Copy aria-hidden="true" class="size-4" />
				{m.settings_copy_info()}
			{/if}
		</Button>
		{#if copy.error}
			<p role="alert" class="text-sm text-state-error">{copy.error}</p>
		{/if}
		{#if runtime.error}
			<DataErrorNotice error={runtime.error} />
		{/if}
	</SettingsRow>
	<SettingsRow
		id="dx-logs"
		title={m.settings_log_files_title()}
		description={m.settings_log_files_description()}
	>
		{#if isTauriTransport()}
			<Button type="button" variant="outline" class="min-h-tap md:min-h-9" onclick={openLogFolder}>
				<FolderOpen aria-hidden="true" class="size-4" />
				{m.settings_open_log_folder()}
			</Button>
		{/if}
		<Button
			type="button"
			variant="outline"
			class="min-h-tap md:min-h-9"
			onclick={() => void copyRecentLogs()}
		>
			{#if copyLogs.copied}
				<Check aria-hidden="true" class="size-4" />
				{m.settings_copied()}
			{:else}
				<Copy aria-hidden="true" class="size-4" />
				{m.settings_copy_logs()}
			{/if}
		</Button>
		{#if logNotice}
			<p class="w-full text-sm text-ink-2" data-testid="log-notice">{logNotice}</p>
		{/if}
		{#if copyLogs.error}
			<p role="alert" class="w-full text-sm text-state-error">{copyLogs.error}</p>
		{/if}
		{#if logError}
			<div class="w-full"><DataErrorNotice error={logError} /></div>
		{/if}
	</SettingsRow>
</SettingsWell>
