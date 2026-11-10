<script lang="ts">
	/**
	 * Notes: the composer that adds one, then the list, newest conversation day
	 * first, whitespace preserved.
	 *
	 * Deleting a Note takes its own control with it, so focus lands on the
	 * section's heading rather than on nothing. Undo lives in the status line
	 * and brings the Note back exactly where it was.
	 */
	import { matchingEntries, sortedEntries } from './notes-order.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import RecordPanelNoteEntry from './record-panel-note-entry.svelte';
	import RecordPanelNoteComposer from './record-panel-note-composer.svelte';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import type {
		Worker,
		WorkerNote,
		WorkerNoteEdit,
		WorkerNoteInput
	} from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';

	let {
		worker,
		headingId,
		onAddNote,
		onDeleteNote,
		onEditNote,
		onRestoreNote,
		refresh,
		onSaved
	}: {
		worker: Worker;
		headingId: string;
		/** Adds a Note and answers the stored record. */
		onAddNote: (note: WorkerNoteInput) => Promise<Worker>;
		/** Takes one Note off by id. */
		onDeleteNote: (noteId: string) => Promise<void>;
		/** Rewrites one Note in place. */
		onEditNote: (edit: WorkerNoteEdit) => Promise<void>;
		/** Puts a deleted Note back exactly as it was. */
		onRestoreNote: (note: WorkerNote) => Promise<void>;
		refresh: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
	} = $props();

	let heading = $state<HTMLHeadingElement | null>(null);
	let query = $state('');
	const shown = $derived(matchingEntries(sortedEntries(worker.notes), query));
</script>

<section aria-labelledby={headingId} class="grid gap-3">
	<h3 id={headingId} bind:this={heading} tabindex="-1" class="label">
		{m.workers_notes_heading()}
	</h3>
	<RecordPanelNoteComposer {worker} onAdd={onAddNote} onDelete={onDeleteNote} {refresh} {onSaved} />
	{#if worker.notes.length > 1}
		<Input
			type="search"
			bind:value={query}
			placeholder={m.workers_notes_search()}
			aria-label={m.workers_notes_search()}
		/>
	{/if}
	{#if worker.notes.length && shown.length === 0}
		<p class="text-sm text-ink-3">{m.workers_notes_no_match()}</p>
	{:else if worker.notes.length}
		<ul class="grid gap-4">
			{#each shown as note (note.id)}
				<li>
					<RecordPanelNoteEntry
						{worker}
						{note}
						onEdit={onEditNote}
						onDelete={onDeleteNote}
						onRestore={onRestoreNote}
						onDeleted={() => heading?.focus()}
						{refresh}
						{onSaved}
					/>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-ink-3">{m.workers_notes_empty()}</p>
	{/if}
</section>
