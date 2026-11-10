<script lang="ts">
	/**
	 * The Notes composer: a multi-line text area and a Save, shown only
	 * while it is expanded. It starts collapsed to one "Add a note" line and
	 * expands on focus. Enter writes a new line; Ctrl/Cmd+Enter or Save adds the
	 * Note and reports it, with Undo taking that Note straight back off.
	 *
	 * While there is something typed the composer is an open draft, so clicking
	 * another Worker saves it rather than dropping it.
	 */
	import { onMount, tick } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Textarea } from '#lib/components/ui/textarea/index.ts';
	import { getEditModel } from '../edit-model.svelte.ts';
	import { runSingleEdit } from '../data-table/data-table-bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import type { Worker, WorkerNoteInput } from '#lib/domain-vocabulary.ts';
	import { getPanelDraft } from './panel-draft-state.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';

	const editModel = getEditModel();
	const panelDraft = getPanelDraft();
	const uid = $props.id();

	let {
		worker,
		onAdd,
		onDelete,
		refresh,
		onSaved
	}: {
		worker: Worker;
		/** Adds the Note and answers the stored record, so its new id can be found. */
		onAdd: (note: WorkerNoteInput) => Promise<Worker>;
		/** Takes one Note off by id; the way back from an add. */
		onDelete: (noteId: string) => Promise<void>;
		refresh: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
	} = $props();

	let text = $state('');
	let saving = $state(false);
	/** Local UI state only: collapsing never touches the draft held in `text`. */
	let expanded = $state(false);
	let pointerDown = false;
	let errorMessage = $state('');
	let box = $state<HTMLTextAreaElement | null>(null);

	const textId = `${uid}-note-text`;
	const hintId = `${uid}-note-hint`;

	/** macOS writes ⌘ where everyone else writes Ctrl. */
	const modifier = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl';
	const hint = $derived(m.workers_note_hint({ modifier }));

	const typed = $derived(text.trim() !== '');

	/**
	 * Adds what the composer holds. Answers `true` once the Note landed (or there
	 * was nothing to add) and `false` when the core refused it, in which case the
	 * text stays where the organizer left it.
	 */
	async function commit(): Promise<boolean> {
		if (saving) return false;
		if (!typed) return true;

		const note: WorkerNoteInput = { text: text.trim() };
		// The Notes the record already held, so the added one can be named for Undo.
		const before = new Set(worker.notes.map((existing) => existing.id));
		let addedId: string | null = null;
		// Snapshot the writes: Undo must reach this Worker after the selection moves.
		const add = onAdd;
		const takeOff = onDelete;

		saving = true;
		errorMessage = '';
		const report = await runSingleEdit({
			apply: async () => {
				const stored = await add(note);
				addedId = stored.notes.find((candidate) => !before.has(candidate.id))?.id ?? null;
			},
			restore: () => (addedId === null ? Promise.resolve() : takeOff(addedId)),
			refresh,
			summary: m.workers_note_added({ worker: worker.name }),
			fallback: m.workers_note_add_failed()
		});
		saving = false;

		if (report.error) {
			errorMessage = m.workers_note_add_failed_retry();
			box?.focus();
			return false;
		}

		text = '';
		onSaved?.(report);
		// The text area is disabled while the write is in flight, which drops
		// focus; it is taken back once the field is enabled again.
		await tick();
		box?.focus();
		return true;
	}

	$effect(() => {
		if (!typed) return;
		return editModel.registerDraft(commit);
	});

	// A stored draft the panel restored reopens the composer holding it, without
	// focus: it is reopened for the organizer to look at, not to type straight into.
	onMount(() => {
		const restored = panelDraft.restored.composer;
		if (restored) {
			text = restored.text;
		}
	});

	// What the composer holds, as typed, is part of the Worker's draft.
	$effect(() => {
		panelDraft.setComposer(typed ? { text } : undefined);
		return () => panelDraft.setComposer(undefined);
	});

	function clear() {
		text = '';
	}
</script>

<svelte:window
	onpointerdowncapture={() => (pointerDown = true)}
	onpointerupcapture={() => (pointerDown = false)}
	onpointercancel={() => (pointerDown = false)}
/>

<div
	class="grid gap-2"
	onfocusin={() => (expanded = true)}
	onfocusout={(event) => {
		const next = event.relatedTarget;
		if (next instanceof Node && event.currentTarget.contains(next)) return;
		const container = event.currentTarget;
		const settle = () => {
			if (!container.contains(document.activeElement)) expanded = false;
		};
		// Collapsing mid-press would shift the Notes below before the click lands
		// on them, so a press that moved the focus is let finish first.
		if (pointerDown) {
			window.addEventListener('pointerup', () => setTimeout(settle, 0), { once: true });
		} else {
			settle();
		}
	}}
>
	<Textarea
		id={textId}
		bind:ref={box}
		bind:value={text}
		rows={expanded ? 3 : 1}
		class={expanded
			? 'max-h-60 border-input bg-transparent'
			: 'max-h-10 min-h-0 resize-none border-input bg-transparent py-2 leading-5'}
		placeholder={m.workers_note_placeholder()}
		aria-label={m.workers_note_aria()}
		disabled={saving}
		aria-describedby={expanded ? hintId : undefined}
		onkeydown={(event) => {
			// Enter is the organizer's own line break; the shortcut is the commit.
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void commit();
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				clear();
			}
		}}
	/>
	{#if expanded}
		<p id={hintId} class="text-xs text-muted-foreground">{hint}</p>
	{/if}
	{#if errorMessage}
		<p role="alert" class="text-sm text-state-error">{errorMessage}</p>
	{/if}
	{#if expanded}
		<Button
			type="button"
			size="sm"
			class="min-h-tap justify-self-start focus-visible:border-transparent lg:min-h-8"
			disabled={saving || !typed}
			aria-busy={saving}
			onclick={() => void commit()}
		>
			{m.common_save()}
		</Button>
	{/if}
</div>
