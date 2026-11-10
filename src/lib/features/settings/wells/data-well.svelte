<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import { getContext } from 'svelte';
	import {
		dataErrorCopy,
		getDataFile,
		revealDataFile,
		type DataErrorCopy
	} from '#lib/client/data-api.ts';
	import { isTauriTransport } from '#lib/client/transport.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { appSettingsContextKey, type AppSettingsContext } from '#lib/shared/app-settings.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { copyText } from '../copy-text.ts';
	import DataErrorNotice from '../data-error-notice.svelte';
	import { formatFileLastWrite, formatFileSize } from '../data-file-details.ts';
	import SettingsRow from '../settings-row.svelte';
	import SettingsWell from '../settings-well.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);

	let dataFilePath = $state('');
	let dataFileSizeBytes = $state<number | null>(null);
	let dataFileModifiedAt = $state<string | null>(null);
	let dataFilePathError = $state<DataErrorCopy | null>(null);
	let revealError = $state<DataErrorCopy | null>(null);
	let revealing = $state(false);
	let copiedPath = $state(false);
	/* "Not read yet" is not the same state as "the core could not read it". */
	let loaded = $state(false);

	async function loadDataFile(): Promise<void> {
		dataFilePathError = null;
		try {
			const file = await getDataFile();
			dataFilePath = file.path;
			dataFileSizeBytes = file.sizeBytes;
			dataFileModifiedAt = file.modifiedAt;
		} catch (error) {
			dataFilePathError = dataErrorCopy(error, m.settings_data_error_read_path());
		} finally {
			loaded = true;
		}
	}

	/* The live file's details, in the reader's saved formats. Before the first read lands
	   the row says it is reading; only a read that landed says a value is unavailable. */
	const dataFileSize = $derived(
		loaded
			? formatFileSize(dataFileSizeBytes, m.settings_unavailable_value())
			: m.settings_reading()
	);
	const dataFileModified = $derived(
		loaded
			? formatFileLastWrite(
					dataFileModifiedAt,
					{ dateFormat: settings.dateFormat, timeFormat: settings.timeFormat },
					m.settings_unavailable_value()
				)
			: m.settings_reading()
	);
	const dataFilePathText = $derived(
		dataFilePath.length > 0
			? dataFilePath
			: loaded
				? m.settings_unavailable_value()
				: m.settings_reading()
	);

	/* Settings writes land in the same file, so the shown details follow them. This is the
	   only first read: onMount here duplicated the request. */
	$effect(() => {
		if (!settings.saving) void loadDataFile();
	});

	async function copyDataFilePath(): Promise<void> {
		if (dataFilePath.length === 0) return;

		try {
			await copyText(dataFilePath);
			dataFilePathError = null;
			copiedPath = true;
			setTimeout(() => (copiedPath = false), 1600);
		} catch {
			dataFilePathError = { message: m.settings_data_error_copy_path(), detail: '' };
		}
	}

	/* Show in Finder belongs to the desktop shell, which is the only side that can reveal a
	   file in the operating system's file manager. */
	async function showDataFile(): Promise<void> {
		if (dataFilePath.length === 0) return;

		revealing = true;
		revealError = null;
		try {
			await revealDataFile(dataFilePath);
		} catch (error) {
			revealError = dataErrorCopy(error, m.settings_data_error_show_file());
		} finally {
			revealing = false;
		}
	}
</script>

<SettingsWell id="data" title={m.settings_data_title()} description={m.settings_data_description()}>
	<SettingsRow id="data-file" title={m.settings_database_file()} stacked>
		<code
			data-selectable
			class="prose-value w-full min-w-0 rounded-control bg-inset px-3 py-2 font-mono text-xs leading-5 text-ink-2 select-text"
			>{dataFilePathText}</code
		>
		<div class="flex w-full flex-wrap items-center gap-2">
			<Button
				type="button"
				variant="outline"
				class="min-h-tap md:min-h-9"
				disabled={dataFilePath.length === 0}
				onclick={() => void copyDataFilePath()}
			>
				{#if copiedPath}
					<Check aria-hidden="true" class="size-4" />
					{m.settings_copied()}
				{:else}
					<Copy aria-hidden="true" class="size-4" />
					{m.settings_copy_path()}
				{/if}
			</Button>
			{#if isTauriTransport()}
				<Button
					type="button"
					variant="outline"
					class="min-h-tap md:min-h-9"
					disabled={dataFilePath.length === 0 || revealing}
					onclick={() => void showDataFile()}
				>
					<FolderOpen aria-hidden="true" class="size-4" />
					{m.settings_show_in_finder()}
				</Button>
			{/if}
		</div>
		<p class="flex w-full flex-wrap items-baseline gap-x-4 gap-y-1">
			<span class="flex items-baseline gap-1.5">
				<span class="key">{m.settings_data_size()}</span>
				<span class="num text-sm text-ink" data-db-size-bytes={dataFileSizeBytes ?? undefined}
					>{dataFileSize}</span
				>
			</span>
			<span class="flex items-baseline gap-1.5">
				<span class="key">{m.settings_data_last_write()}</span>
				<span class="num text-sm text-ink" data-db-modified-at={dataFileModifiedAt ?? undefined}
					>{dataFileModified}</span
				>
			</span>
		</p>
		{#if dataFilePathError}
			<DataErrorNotice error={dataFilePathError} />
		{/if}
		{#if revealError}
			<DataErrorNotice error={revealError} />
		{/if}
	</SettingsRow>
</SettingsWell>
