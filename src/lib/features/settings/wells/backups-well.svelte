<script lang="ts">
	import FileDown from '@lucide/svelte/icons/file-down';
	import Upload from '@lucide/svelte/icons/upload';
	import { getContext, onMount } from 'svelte';
	import { autoBackupFrequencies, type AutoBackupFrequency } from '#lib/client/auto-backup-api.ts';
	import { exportBackup, pickBackupPath } from '#lib/client/backup-api.ts';
	import { dataErrorCopy, pickRestorePath, restoreBackup } from '#lib/client/data-api.ts';
	import { isTauriTransport } from '#lib/client/transport.ts';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';
	import { Checkbox } from '#lib/components/ui/checkbox/index.ts';
	import { createRestoreFlow } from '../restore-flow.svelte.ts';
	import { autoBackupContextKey, type AutoBackup } from '../auto-backup.svelte.ts';
	import { appSettingsContextKey, type AppSettingsContext } from '#lib/shared/app/app-settings.ts';
	import { formatTimestamp } from '#lib/shared/text/format.ts';
	import Picker from '../picker.svelte';
	import SettingsSwitch from '../settings-switch.svelte';
	import { clearLanguage } from '#lib/i18n/language-cache.ts';
	import { m } from '#lib/paraglide/messages.js';
	import DataErrorNotice from '../data-error-notice.svelte';
	import FileReceipt from '../file-receipt.svelte';
	import { reloadPage } from '../reload-page.ts';
	import SettingsRow from '../settings-row.svelte';
	import SettingsWell from '../settings-well.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);
	const autoBackup = getContext<AutoBackup>(autoBackupContextKey);
	onMount(() => void autoBackup.refresh());

	const autoStatus = $derived(autoBackup.status);
	const frequencyChoices = $derived(
		autoBackupFrequencies.map((value) => ({
			value,
			label:
				value === 'daily'
					? m.settings_backup_frequency_daily()
					: m.settings_backup_frequency_weekly()
		}))
	);
	const when = (iso: string): string =>
		formatTimestamp(iso, { dateFormat: settings.dateFormat, timeFormat: settings.timeFormat });

	let exporting = $state(false);
	let exportError = $state('');
	let exportSaved = $state('');

	/*
	 * The save dialog belongs to the desktop shell, which is the only side that can ask
	 * the operating system for a path. pickBackupPath in #lib/client reaches it.
	 */
	async function startExport(): Promise<void> {
		exporting = true;
		exportError = '';
		exportSaved = '';
		try {
			const path = await pickBackupPath();
			if (path === null) return;

			await exportBackup(path);
			exportSaved = path;
		} catch (error) {
			exportError = dataErrorCopy(error, m.settings_data_error_export()).message;
		} finally {
			exporting = false;
		}
	}

	let restoreOpen = $state(false);
	const restore = createRestoreFlow({
		pick: pickRestorePath,
		restore: restoreBackup,
		done: clearLanguage,
		failure: () => m.settings_data_error_restore(),
		required: () => m.settings_restore_source_required()
	});
</script>

<SettingsWell
	id="backups"
	title={m.settings_backups_title()}
	description={m.settings_backups_description()}
>
	{#if isTauriTransport()}
		<SettingsRow
			id="bak-export"
			title={m.settings_export_title()}
			description={m.settings_export_description()}
		>
			<div class="grid gap-2">
				<Button
					type="button"
					class="min-h-tap md:min-h-9"
					onclick={startExport}
					disabled={exporting}
				>
					<FileDown aria-hidden="true" class="size-4" />
					{exporting ? m.settings_exporting() : m.settings_export_button()}
				</Button>
				{#if exportSaved}
					<p class="text-sm text-ink-2" role="status">{m.settings_backup_saved()}</p>
					<FileReceipt path={exportSaved} />
				{/if}
				{#if exportError}
					<p class="text-sm text-state-error" role="alert">{exportError}</p>
				{/if}
			</div>
		</SettingsRow>
	{/if}
	<SettingsRow
		id="bak-auto"
		title={m.settings_auto_backup_title()}
		description={m.settings_auto_backup_description()}
	>
		<Button
			type="button"
			variant="outline"
			class="min-h-tap md:min-h-9"
			disabled={!autoStatus?.available || autoBackup.busy}
			onclick={() => void autoBackup.backUpNow()}
		>
			{autoBackup.busy ? m.settings_auto_backup_running() : m.settings_auto_backup_now()}
		</Button>
		<SettingsSwitch
			checked={autoStatus?.enabled ?? false}
			disabled={!autoStatus?.available || autoBackup.busy}
			onchange={(checked) => void autoBackup.change({ enabled: checked })}
			labelledby="bak-auto-title"
		/>
	</SettingsRow>
	<SettingsRow id="bak-auto-frequency" title={m.settings_backup_frequency_title()}>
		<Picker
			rowId="bak-auto-frequency"
			choices={frequencyChoices}
			value={autoStatus?.frequency ?? 'daily'}
			onChange={(value) => void autoBackup.change({ frequency: value as AutoBackupFrequency })}
			disabled={!autoStatus?.enabled || autoBackup.busy}
		/>
	</SettingsRow>
	<div class="grid gap-1 px-6 pb-4 text-sm" aria-live="polite" data-testid="auto-backup-status">
		{#if autoStatus?.lastBackupAt}
			<p class="text-ink-2">
				{m.settings_auto_backup_last({ when: when(autoStatus.lastBackupAt) })}
			</p>
		{:else if autoStatus?.available}
			<p class="text-ink-2">{m.settings_no_auto_backup()}</p>
		{/if}
		{#if autoStatus?.failure}
			<p class="text-state-error" role="alert">
				{m.settings_auto_backup_failed({ when: when(autoStatus.failure.at) })}
			</p>
		{/if}
		{#if autoBackup.error}
			<p class="text-state-error" role="alert">{autoBackup.error}</p>
		{/if}
	</div>
	<SettingsRow
		id="bak-restore"
		title={m.settings_restore_title()}
		description={m.settings_restore_description()}
	>
		{#if isTauriTransport()}
			<Button
				type="button"
				variant="outline"
				class="min-h-tap md:min-h-9"
				onclick={() => (restoreOpen = true)}
			>
				<Upload aria-hidden="true" class="size-4" />
				{m.settings_restore_button()}
			</Button>
		{:else}
			<p class="text-sm text-ink-3">{m.settings_restore_needs_desktop()}</p>
		{/if}
	</SettingsRow>
</SettingsWell>

<!-- Restore: replaces everything, so it names what will be lost and where the safety copy
     goes, and, once the swap is done, the exact file to go back to. -->
<AlertDialog.Root
	bind:open={restoreOpen}
	onOpenChange={(open) => {
		if (!open && restore.busy) {
			restoreOpen = true;
			return;
		}
		if (!open) {
			restore.reset();
		}
	}}
>
	<AlertDialog.Content
		onEscapeKeydown={(event) => {
			if (restore.busy) event.preventDefault();
		}}
	>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.settings_restore_dialog_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.settings_restore_dialog_description()}
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if restore.safetyCopy}
			<div class="grid gap-2">
				<p class="text-sm text-ink-2" role="status">{m.settings_restore_safety_copy()}</p>
				<FileReceipt path={restore.safetyCopy} />
				<Button type="button" class="min-h-tap md:min-h-9" onclick={reloadPage}
					>{m.settings_reload()}</Button
				>
			</div>
		{:else}
			{#if restore.path}
				<div class="grid gap-4">
					<code data-selectable class="prose-value font-mono text-xs break-all">{restore.path}</code
					>
					<div class="flex items-start gap-2">
						<Checkbox id="restore-legacy" bind:checked={restore.legacy} disabled={restore.busy} />
						<Label class="field-label" for="restore-legacy">{m.settings_restore_legacy()}</Label>
					</div>
					{#if !restore.legacy}<div class="grid gap-2">
							<Label class="field-label" for="restore-source-passphrase"
								>{m.settings_restore_passphrase()}</Label
							>
							<Input
								id="restore-source-passphrase"
								type="password"
								bind:value={restore.passphrase}
								autocomplete="off"
								autocapitalize="off"
								spellcheck={false}
								disabled={restore.busy}
							/>
						</div>{/if}
					<p class="text-sm text-ink-2">{m.settings_restore_key_consequence()}</p>
				</div>
			{/if}
			{#if restore.error}
				<DataErrorNotice error={restore.error} />
				{#if restore.recoveryCopy}<p class="text-sm text-ink-2">
						{m.settings_restore_safety_copy()}
					</p>
					<FileReceipt path={restore.recoveryCopy} />{/if}
			{/if}
			<AlertDialog.Footer>
				<AlertDialog.Cancel disabled={restore.busy}>{m.common_cancel()}</AlertDialog.Cancel>
				<Button
					type="button"
					class="min-h-tap md:min-h-9"
					disabled={restore.busy}
					onclick={() => void restore.pick()}
				>
					{restore.path ? m.settings_restore_choose_another() : m.settings_choose_backup()}
				</Button>
				{#if restore.path}<Button
						type="button"
						disabled={restore.busy}
						onclick={() => void restore.submit()}
						>{restore.busy ? m.settings_restoring() : m.settings_restore_submit()}</Button
					>{/if}
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
