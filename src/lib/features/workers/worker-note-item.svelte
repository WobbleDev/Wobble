<script lang="ts">
	/**
	 * One Note, read-only: what was written, and when it was
	 * written and last edited. Shared by the dialog's note list and the expanded
	 * record, so both read a Note the same way.
	 */
	import { getContext } from 'svelte';
	import type { WorkerNote } from '#lib/domain-vocabulary.ts';
	import { appSettingsContextKey, type AppSettingsContext } from '#lib/shared/app-settings.ts';
	import { formatTimestamp } from '#lib/shared/format.ts';
	import { m } from '#lib/paraglide/messages.js';

	let { note }: { note: WorkerNote } = $props();

	/* The installation's Date and Time formats, the one source every Note reads. */
	const settings = getContext<AppSettingsContext>(appSettingsContextKey);
	const formats = $derived({
		dateFormat: settings.dateFormat,
		timeFormat: settings.timeFormat
	});
</script>

<div class="grid min-w-0 gap-1">
	<!-- A Note's own line breaks are the reader's, so they are shown rather than
	     reflowed, and a long unbroken run still wraps. -->
	<p class="prose-value text-pretty whitespace-pre-wrap">{note.text}</p>
	<p class="text-sm text-muted-foreground">
		{m.workers_note_written({
			timestamp: formatTimestamp(note.timestamp, formats)
		})}{#if note.editedAt}
			{m.workers_note_edited({ timestamp: formatTimestamp(note.editedAt, formats) })}{/if}
	</p>
</div>
