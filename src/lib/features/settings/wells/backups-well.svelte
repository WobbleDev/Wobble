<script lang="ts">
	import FileDown from '@lucide/svelte/icons/file-down';
	import Upload from '@lucide/svelte/icons/upload';
	import { exportBackup, pickBackupPath } from '#lib/client/backup-api.ts';
	import { pickRestorePath, restoreBackup } from '#lib/client/data-api.ts';
	import { isTauriTransport } from '#lib/client/transport.ts';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';
	import { Checkbox } from '#lib/components/ui/checkbox/index.ts';
	import { createRestoreFlow } from '../restore-flow.svelte.ts';
	import { clearLanguage } from '#lib/i18n/language-cache.ts';
	import { m } from '#lib/paraglide/messages.js';
	import DataErrorNotice from '../data-error-notice.svelte';
	import FileReceipt from '../file-receipt.svelte';
	import { reloadPage } from '../reload-page.ts';
	import SettingsRow from '../settings-row.svelte';
	import SettingsWell from '../settings-well.svelte';

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
			exportError = error instanceof Error ? error.message : m.settings_data_error_export();
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
