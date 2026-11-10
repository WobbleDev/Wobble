<script lang="ts">
	/**
	 * One Note in the panel. Read, it is the shared Note display behind a button,
	 * with its own Delete beside it; clicked, it becomes the same editor as the
	 * composer: Enter writes a new line, Ctrl/Cmd+Enter or Save stores it, Escape
	 * or Cancel puts it back. Delete takes the Note off at once and reports it in
	 * the status line, whose Undo puts the exact Note back. The written time never
	 * changes; the core marks it edited only when the text really
	 * changed, and Undo restores the earlier edit time exactly. An open edit is a
	 * draft, so selecting another Worker saves it.
	 */
	import { getContext, onMount, tick } from 'svelte';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';
	import { appSettingsContextKey, type AppSettingsContext } from '#lib/shared/app-settings.ts';
	import { formatTimestamp } from '#lib/shared/format.ts';
	import { Textarea } from '#lib/components/ui/textarea/index.ts';
	import WorkerNoteItem from '../worker-note-item.svelte';
	import { getEditModel } from '../edit-model.svelte.ts';
	import { runSingleEdit } from '../data-table/data-table-bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import type { Worker, WorkerNote, WorkerNoteEdit } from '#lib/domain-vocabulary.ts';
	import { getPanelDraft } from './panel-draft-state.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';

	const editModel = getEditModel();
	const panelDraft = getPanelDraft();
	/* The installation's Date and Time formats, the one source every Note reads. */
	const settings = getContext<AppSettingsContext>(appSettingsContextKey);
	const formats = $derived({
		dateFormat: settings.dateFormat,
		timeFormat: settings.timeFormat
	});
	const uid = $props.id();

	let {
		worker,
		note,
		onEdit,
		onDelete,
		onRestore,
		onDeleted,
		refresh,
		onSaved
	}: {
		worker: Worker;
		note: WorkerNote;
		onEdit: (edit: WorkerNoteEdit) => Promise<void>;
		onDelete: (noteId: string) => Promise<void>;
		/** Puts this Note back exactly as it was, which is what its Undo sends. */
		onRestore: (note: WorkerNote) => Promise<void>;
		/** Where focus goes once this Note's own control has left the page. */
		onDeleted?: () => void;
		refresh: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
	} = $props();

	let editing = $state(false);
	let text = $state('');
	let saving = $state(false);
	let errorMessage = $state('');
	let box = $state<HTMLTextAreaElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);

	const textId = `${uid}-edit-text`;
	const hintId = `${uid}-edit-hint`;
	const modifier = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl';
	const hint = $derived(m.workers_note_hint({ modifier }));

	const changed = $derived(editing && text.trim() !== note.text);

	async function open() {
		text = note.text;
		errorMessage = '';
		editing = true;
		await tick();
		box?.focus();
	}

	async function close() {
		editing = false;
		await tick();
		trigger?.focus();
	}

	/** Answers `false` only when the core refused, leaving the editor open. */
	async function commit(): Promise<boolean> {
		if (saving) return false;
		if (!changed) {
			await close();
			return true;
		}
		if (text.trim() === '') {
			errorMessage = m.workers_note_needs_text();
			box?.focus();
			return false;
		}

		const before: WorkerNoteEdit = {
			id: note.id,
			text: note.text,
			editedAt: note.editedAt ?? null
		};
		saving = true;
		errorMessage = '';
		// Snapshot the write: Undo must reach this Worker after the selection moves.
		const edit = onEdit;
		const report = await runSingleEdit({
			apply: () => edit({ id: note.id, text: text.trim() }),
			restore: () => edit(before),
			refresh,
			summary: m.workers_note_saved({ worker: worker.name }),
			fallback: m.workers_note_save_failed()
		});
		saving = false;

		if (report.error) {
			errorMessage = m.workers_note_save_failed_retry();
			box?.focus();
			return false;
		}
		onSaved?.(report);
		await close();
		return true;
	}

	/**
	 * Takes the Note off the record and reports it. Its Undo sends the whole Note
	 * back — id, written time and edit time included — so the record reads exactly
	 * as it did before.
	 */
	async function remove(): Promise<boolean> {
		if (saving) return false;

		saving = true;
		errorMessage = '';
		const takeOff = onDelete;
		const putBack = onRestore;
		const removed = note;
		const report = await runSingleEdit({
			apply: () => takeOff(removed.id),
			restore: () => putBack(removed),
			refresh,
			summary: m.workers_note_deleted({ worker: worker.name }),
			fallback: m.workers_note_delete_failed()
		});
		saving = false;

		if (report.error) {
			errorMessage = m.workers_note_delete_failed_retry();
			return false;
		}
		onSaved?.(report);
		// The control that was just clicked is gone, so focus moves up to the section.
		onDeleted?.();
		return true;
	}

	$effect(() => {
		if (!changed) return;
		return editModel.registerDraft(commit);
	});

	// A stored draft the panel restored reopens this Note's editor holding it,
	// without focus: it is reopened to be checked, not typed straight into.
	onMount(() => {
		const restored = panelDraft.restored.noteEdits[note.id];
		if (restored) {
			text = restored.text;
			editing = true;
		}
	});

	// This Note's open edit is part of the Worker's draft, by Note id.
	$effect(() => {
		const id = note.id;
		panelDraft.setNoteEdit(id, changed ? { text } : undefined);
		return () => panelDraft.setNoteEdit(id, undefined);
	});
</script>

{#if editing}
	<div class="grid gap-2">
		<Label for={textId}>{m.workers_note_edit_label()}</Label>
		<Textarea
			id={textId}
			bind:ref={box}
			bind:value={text}
			rows={3}
			class="max-h-60"
			disabled={saving}
			aria-describedby={hintId}
			onkeydown={(event) => {
				if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
					event.preventDefault();
					void commit();
					return;
				}
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					void close();
				}
			}}
		/>
		<p id={hintId} class="text-xs text-muted-foreground">{hint}</p>
		{#if errorMessage}
			<p role="alert" class="text-sm text-state-error">{errorMessage}</p>
		{/if}
		<div class="flex gap-2">
			<Button
				type="button"
				size="sm"
				class="min-h-tap lg:min-h-8"
				disabled={saving}
				aria-busy={saving}
				onclick={() => void commit()}
			>
				{m.common_save()}
			</Button>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				class="min-h-tap lg:min-h-8"
				disabled={saving}
				onclick={() => void close()}
			>
				{m.common_cancel()}
			</Button>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				class="ml-auto min-h-tap text-state-error hover:bg-state-error/10 lg:min-h-8"
				disabled={saving}
				onclick={() => void remove()}
			>
				{m.common_delete()}
			</Button>
		</div>
	</div>
{:else}
	<div class="flex items-start gap-1">
		<!-- Kept raw: this button wraps the whole note body, which the ui Button cannot hold without changing its layout. -->
		<button
			bind:this={trigger}
			type="button"
			class="-mx-2 min-w-0 flex-1 rounded-control px-2 py-1 text-left hover:bg-hover"
			aria-label={m.workers_note_edit_aria({
				timestamp: formatTimestamp(note.timestamp, formats)
			})}
			onclick={() => void open()}
		>
			<WorkerNoteItem {note} />
		</button>
		<Button
			type="button"
			variant="ghost"
			size="icon"
			class="min-h-tap min-w-tap shrink-0 text-muted-foreground hover:text-state-error"
			aria-label={m.workers_note_delete_aria({
				timestamp: formatTimestamp(note.timestamp, formats)
			})}
			disabled={saving}
			onclick={() => void remove()}
		>
			<Trash2Icon class="size-4" />
		</Button>
	</div>
{/if}
