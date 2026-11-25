<script lang="ts">
	/**
	 * One single-line field of the record, edited where it is shown. The value is a
	 * button; clicking it turns the field into a full-width input with Save and
	 * Cancel beneath. Enter or Save commits, Escape or Cancel puts the old value
	 * back, and focus returns to the value button either way.
	 *
	 * An `inline` field (Contact's Email and Phone) is a whole row instead: a lead icon,
	 * the value, and a trailing slot. Editing swaps the value for an input in the same
	 * box and the slot for icon Save and Cancel buttons, so nothing around it moves and
	 * no popover opens. The value truncates to one line with the whole of it in `title`.
	 *
	 * A commit that changes nothing sends no request and reports nothing. A commit
	 * the core refuses keeps the editor open with what was typed and says why in
	 * the UI's own words (ADR-0024); the core's message never reaches the screen.
	 */
	import { onMount, tick, untrack } from 'svelte';
	import { formatPhoneDigits, formatPhoneInput, phoneDigits } from '../phone.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import { cn } from '#lib/utils.ts';
	import type { Snippet } from 'svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import XIcon from '@lucide/svelte/icons/x';
	import { getEditModel } from '#lib/features/workers/edit-model.svelte.ts';
	import { runSingleEdit } from '../data-table/bulk-actions/bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/features.ts';
	import { getPanelDraft } from './panel-draft-state.svelte.ts';
	import type { PanelTextField } from './panel-draft.ts';
	import { m } from '#lib/paraglide/messages.js';

	type Props = {
		/** The field as the organizer reads it: Nombre, Correo electrónico or Teléfono. */
		label: string;
		/** Which stored field this is, for the localized refusal copy. */
		fieldKind: 'name' | 'email' | 'phone';
		/** The complete closed-button label: "Edit email". */
		editLabel: string;
		/** The Name field's label, which names the value: "{value}, edit name". */
		editValueLabel?: (value: string) => string;
		/** What the record holds now. */
		value: string;
		/** What an empty value invites: "Add email". */
		placeholder: string;
		/** What the live input shows when empty; defaults to `placeholder`. */
		inputPlaceholder?: string;
		/** The input's own type, so a phone keypad appears where that applies. */
		type?: 'text' | 'email' | 'tel';
		/** Phone: a digits-only mask laid out `(xxx) xxx-xxxx` as it is typed. */
		mask?: 'phone';
		/** Undo's write when the previous value may predate validation (Phone). */
		onRestore?: (value: string) => Promise<void>;
		/** Name: the value is the panel's level-2 heading, and the editor larger. */
		title?: boolean;
		/** Whose record this is, for the status line's message. */
		workerName: string;
		/** Writes the trimmed value. The core validates it. */
		onSave: (value: string) => Promise<void>;
		/** Reloads the Workers table once the write has landed. */
		refresh: () => Promise<void>;
		/** Reports a landed save: the status line's message and its Undo. */
		onSaved?: (report: DataTableEditReport) => void;
		/** New Worker: creating instead of saving. Answers false when the core refused. */
		onCreate?: (value: string) => Promise<boolean>;
		/** New Worker: the placeholder is abandoned (Escape, Cancel, or an empty name). */
		onCancelCreate?: () => void;
		/** Keeps this field's unsaved typing as part of the Worker's draft (ADR-0023). */
		draftKey?: PanelTextField;
		/** Shows the field as a one-line row that edits in place (Email, Phone). */
		inline?: boolean;
		/** Inline: the row's leading icon, which stays put while editing. */
		lead?: Snippet;
		/** Inline: what fills the row's trailing slot while not editing (the copy button). */
		trail?: Snippet;
	};

	let {
		label,
		fieldKind,
		editLabel,
		editValueLabel,
		value,
		placeholder,
		inputPlaceholder,
		type = 'text',
		mask,
		title = false,
		workerName,
		onSave,
		onRestore,
		refresh,
		onSaved,
		onCreate,
		onCancelCreate,
		draftKey,
		inline = false,
		lead,
		trail
	}: Props = $props();

	let editing = $state(false);
	let draft = $state('');
	let errorMessage = $state('');
	let saving = $state(false);
	let input = $state<HTMLInputElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);
	let row = $state<HTMLElement | null>(null);
	/** A restored draft reopens the editor without taking focus from where the organizer is. */
	let restoredOpen = $state(false);

	const editModel = getEditModel();
	// The draft key names which editor this is for the whole life of the instance; it is
	// read once on purpose, and the effect below is what keeps the panel's draft current.
	const panelDraft = untrack(() => (draftKey ? getPanelDraft() : null));

	// While this field is open, the view flushes what is typed here before the
	// selection changes or a bulk edit starts, rather than dropping it. A refused
	// write leaves the editor registered: it is still holding the organizer's text.
	$effect(() => {
		if (!editing) return;
		return editModel.registerDraft(() => commit(false));
	});

	// New Worker opens straight into the Name editor, so the organizer types the
	// name without a click first.
	onMount(() => {
		if (onCreate) startEditing();
		const restored = draftKey ? panelDraft?.restored[draftKey] : undefined;
		if (restored !== undefined) {
			draft = restored;
			restoredOpen = true;
			editing = true;
		}
	});

	// What this field holds, as typed, is part of the Worker's draft; closing it takes
	// the text back out. A restored editor opens without focus: the organizer is not
	// dropped into it the moment the selection changes.
	$effect(() => {
		if (!draftKey || !panelDraft) return;
		panelDraft.setField(draftKey, editing ? draft : undefined);
		return () => panelDraft.setField(draftKey, undefined);
	});

	// An inline editor has no popover to notice a click away, so it does the same itself:
	// pressing outside the row saves what is typed, as moving to another Worker does, and a
	// refused write keeps the editor open with its message. Listening to the press, not to
	// blur, keeps Cancel working where a button click does not take focus (Safari).
	$effect(() => {
		if (!inline || !editing) return;
		const away = (event: PointerEvent) => {
			if (event.target instanceof Node && row?.contains(event.target)) return;
			// A restored draft the organizer has not touched is theirs to keep or discard from the
			// banner; pressing there must not save it.
			if (restoredOpen) return;
			void commit(false);
		};
		document.addEventListener('pointerdown', away, true);
		return () => document.removeEventListener('pointerdown', away, true);
	});

	const empty = $derived(!value);

	/** True on the Phone field: the only editor that masks what is typed. */
	const phoneMask = $derived(mask === 'phone');

	/** How many digits stand before this caret position, the mask's own coordinate. */
	function digitsBefore(text: string, caret: number): number {
		return (text.slice(0, caret).match(/\d/g) ?? []).length;
	}

	/** Where the caret sits once `count` digits precede it in the formatted text. */
	function caretForDigits(text: string, count: number): number {
		if (count <= 0) return 0;
		let seen = 0;
		for (let index = 0; index < text.length; index += 1) {
			if (!/\d/.test(text[index])) continue;
			seen += 1;
			if (seen === count) return index + 1;
		}
		return text.length;
	}

	/**
	 * Shows `next`, with the caret after `digitIndex` digits. The vendored Input binds
	 * its own value, which can put the raw text back after this handler; rewriting the
	 * DOM in a tick wins that race, and leaves the caret measured in digits either way.
	 */
	function showMasked(next: string, digitIndex: number) {
		draft = next;
		void tick().then(() => {
			if (!input) return;
			if (input.value !== next) input.value = next;
			const position = caretForDigits(next, digitIndex);
			input.setSelectionRange(position, position);
		});
	}

	/** Keeps only digits, lays them out, and leaves the caret on the same digit. */
	function onInput(event: Event) {
		const element = event.currentTarget as HTMLInputElement;
		restoredOpen = false;
		if (!phoneMask) {
			draft = element.value;
			return;
		}

		const caret = element.selectionStart ?? element.value.length;
		const digitIndex = digitsBefore(element.value, caret);
		showMasked(formatPhoneInput(element.value), digitIndex);
	}

	/**
	 * Backspace just after the mask's punctuation removes the digit before it. The
	 * browser would otherwise delete the punctuation, and the mask would put it back.
	 */
	function onKeydown(event: KeyboardEvent) {
		if (!phoneMask || event.key !== 'Backspace' || !input) return;
		const start = input.selectionStart ?? 0;
		if (start !== (input.selectionEnd ?? 0) || start === 0) return;
		if (/\d/.test(input.value[start - 1])) return;

		event.preventDefault();
		const digitIndex = digitsBefore(input.value, start);
		if (digitIndex === 0) return;

		const digits = phoneDigits(input.value);
		const next = digits.slice(0, digitIndex - 1) + digits.slice(digitIndex);
		showMasked(formatPhoneDigits(next), digitIndex - 1);
	}

	/** The button's own name where the value is not the name, and the name plus the
	 *  hint where it is, so the heading still announces whose record this is. */
	const valueLabel = $derived(
		title ? (editValueLabel?.(value || placeholder) ?? editLabel) : editLabel
	);

	/** The UI's words for a refused write, by the core's code (ADR-0024). */
	function failureCopy(code: string | undefined): string {
		if (code === 'worker_not_found') {
			return m.workers_save_worker_deleted();
		}
		if (code === 'invalid_worker') {
			if (fieldKind === 'name') return m.workers_save_name_required();
			if (fieldKind === 'email') return m.workers_save_email_invalid();
			if (fieldKind === 'phone') return m.workers_save_phone_invalid();
		}

		return m.workers_save_field_failed({ field: label });
	}

	function focusValue() {
		void tick().then(() => trigger?.focus());
	}

	/** The text the editor opened with, so a late focus can tell whether anything was typed since. */
	let openedWith = '';

	function focusInput() {
		void tick().then(() => {
			input?.focus();
			// Selecting after typing has begun would make the next keystroke replace it.
			if (draft === openedWith) input?.select();
		});
	}

	function startEditing() {
		draft = value;
		openedWith = value;
		errorMessage = '';
		restoredOpen = false;
		editing = true;
		// New Worker and inline rows edit in place, so the input exists at once; a popover focuses on open.
		if (onCreate || inline) focusInput();
	}

	/** The popover's own open and close (the value button, Escape) reach the same paths as the buttons. */
	function setOpen(open: boolean) {
		if (open) startEditing();
		else if (editing) cancel();
	}

	function cancel() {
		if (saving) return;
		if (onCreate) {
			onCancelCreate?.();
			return;
		}
		editing = false;
		errorMessage = '';
		focusValue();
	}

	/**
	 * Saves what is typed. Answers `true` once the editor is closed again, or there
	 * was nothing to save, and `false` when the write was refused; a refusal leaves
	 * the editor open with its own message and puts focus back in its input.
	 *
	 * `refocus` is false when the view is flushing this draft to move off the
	 * Worker: the navigation decides where focus lands, and the value button is
	 * about to be remounted for the record that replaces this one.
	 */
	/* The save in flight, if any. A second commit (for example the flush when the selection
	   moves) waits for its real result instead of claiming success, so a refused save is
	   not lost with the unmounted editor. */
	let inFlight: Promise<boolean> | null = null;

	function commit(refocus = true): Promise<boolean> {
		if (inFlight) return inFlight;
		const run = commitNow(refocus).finally(() => {
			if (inFlight === run) inFlight = null;
		});
		inFlight = run;
		return run;
	}

	async function commitNow(refocus: boolean): Promise<boolean> {
		const next = draft.trim();

		// A half-typed Phone flushed because the organizer is moving off this Worker is
		// only a draft, not a save: it neither writes nor blocks the switch. Save and
		// Enter still refuse it, which is why the check is limited to the flush.
		if (phoneMask && !refocus) {
			const digits = phoneDigits(next).length;
			if (digits > 0 && digits < 10) return true;
		}

		if (onCreate) {
			if (!next) {
				onCancelCreate?.();
				return true;
			}
			saving = true;
			errorMessage = '';
			const created = await onCreate(next);
			saving = false;
			if (!created) {
				errorMessage = m.workers_add_worker_failed();
				void tick().then(() => input?.focus());
				return false;
			}
			return true;
		}

		// Nothing changed: no request, no status message, just the value back.
		if (next === value) {
			editing = false;
			if (refocus) focusValue();
			return true;
		}

		const previous = value;
		saving = true;
		errorMessage = '';

		// Snapshot the write now: its Undo must reach this Worker even after the
		// selection has moved on. A previous Phone may predate the format, so its
		// Undo takes the restore path rather than the validating one.
		const save = onSave;
		const restore = onRestore ?? save;
		const report = await runSingleEdit({
			apply: () => save(next),
			restore: () => restore(previous),
			refresh,
			summary: m.workers_field_saved({ worker: workerName, field: label }),
			fallback: m.workers_field_save_fallback({ field: label })
		});
		saving = false;

		// Nothing landed, so the editor stays open holding what was typed, and the
		// organizer is put back in the field that has to change.
		if (report.error) {
			errorMessage = failureCopy(report.errorCode);
			void tick().then(() => input?.focus());
			return false;
		}

		editing = false;
		if (refocus) focusValue();
		onSaved?.(report);
		return true;
	}
</script>

{#snippet form()}
	<!-- Escape is caught on the way up from the form's own controls. -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<form
		class="grid gap-2"
		novalidate
		onkeydown={(event) => {
			// Escape cancels from the input and from Save or Cancel alike.
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			cancel();
		}}
		onsubmit={(event) => {
			event.preventDefault();
			void commit();
		}}
	>
		<Input
			bind:ref={input}
			value={draft}
			oninput={onInput}
			onkeydown={onKeydown}
			{type}
			inputmode={phoneMask ? 'numeric' : undefined}
			placeholder={inputPlaceholder ?? placeholder}
			aria-label={label}
			aria-busy={saving}
			class={cn('w-full min-w-0', title && 'h-9 text-xl font-semibold tracking-title')}
		/>
		{#if errorMessage}
			<p role="alert" class="text-sm text-state-error">{errorMessage}</p>
		{/if}
		<div class="flex items-center gap-2">
			<Button
				type="submit"
				size="sm"
				class="min-h-tap focus-visible:border-transparent lg:min-h-8"
				disabled={saving}>{m.common_save()}</Button
			>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				class="min-h-tap lg:min-h-8"
				onclick={cancel}
				disabled={saving}
			>
				{m.common_cancel()}
			</Button>
		</div>
	</form>
{/snippet}

{#snippet reading()}
	<span
		class={cn(
			'prose-value min-w-0',
			'break-words',
			title ? 'text-xl font-semibold tracking-title text-pretty' : 'text-sm',
			empty && 'font-normal text-ink-3 underline decoration-dotted underline-offset-4'
		)}
	>
		{value || placeholder}
	</span>
{/snippet}

{#snippet inlineRow()}
	<!-- One row, one box: the highlight covers the icon, the value and the trailing slot alike.
	     The value is a button stretched over the whole row, so the icon is a target too. -->
	<div
		bind:this={row}
		class={cn(
			'group/kv relative flex min-h-tap min-w-0 items-center gap-2 rounded-item px-2 transition-colors duration-150 motion-reduce:transition-none lg:min-h-8',
			editing
				? 'bg-panel outline-2 -outline-offset-1 outline-ring'
				: 'hover:bg-hover has-[[data-value]:focus-visible]:outline-2 has-[[data-value]:focus-visible]:-outline-offset-1 has-[[data-value]:focus-visible]:outline-ring'
		)}
	>
		<span class="flex size-4 shrink-0 items-center justify-center text-ink-3"
			>{@render lead?.()}</span
		>
		{#if editing}
			<!-- Escape is caught on the way up from the form's own controls. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<form
				class="flex min-w-0 flex-1 items-center gap-1"
				novalidate
				onkeydown={(event) => {
					if (event.key !== 'Escape') return;
					event.preventDefault();
					event.stopPropagation();
					cancel();
				}}
				onsubmit={(event) => {
					event.preventDefault();
					void commit();
				}}
			>
				<Input
					bind:ref={input}
					value={draft}
					oninput={onInput}
					onkeydown={onKeydown}
					{type}
					inputmode={phoneMask ? 'numeric' : undefined}
					placeholder={inputPlaceholder ?? placeholder}
					aria-label={label}
					aria-busy={saving}
					aria-invalid={errorMessage ? true : undefined}
					class="h-7 min-h-0 flex-1 truncate rounded-none border-0 bg-transparent p-0 shadow-none outline-none focus-visible:outline-none lg:min-h-0"
				/>
				<Button
					type="submit"
					variant="ghost"
					size="icon-xs"
					aria-label={m.common_save()}
					disabled={saving}
				>
					<CheckIcon />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={m.common_cancel()}
					onclick={cancel}
					disabled={saving}
				>
					<XIcon />
				</Button>
			</form>
		{:else}
			<!-- Kept raw: the value is text that is edited from where it stands; the ui Button would restyle it. -->
			<button
				type="button"
				bind:this={trigger}
				data-value
				class="min-w-0 flex-1 text-left text-sm outline-none after:absolute after:inset-0 after:rounded-item after:content-['']"
				aria-label={valueLabel}
				title={value || undefined}
				onclick={startEditing}
			>
				<span
					class={cn(
						'block truncate',
						empty && 'text-ink-3 underline decoration-dotted underline-offset-4'
					)}
				>
					{value || placeholder}
				</span>
			</button>
			<!-- Its own reserved space, so the value truncates before it and never runs under it. -->
			<span class="relative z-10 flex size-6 shrink-0 items-center justify-center">
				{@render trail?.()}
			</span>
		{/if}
	</div>
	{#if errorMessage}
		<p role="alert" class="px-2 pb-1 text-sm text-state-error">{errorMessage}</p>
	{/if}
{/snippet}

{#snippet field()}
	{#if inline}
		{@render inlineRow()}
	{:else if onCreate}
		<!-- New Worker: the Name is typed where it will live, so the form stands in the row. -->
		{#if editing}
			{@render form()}
		{:else}
			<!-- Kept raw: the field value is shown as text and edited in place; the ui Button would restyle it. -->
			<button
				type="button"
				bind:this={trigger}
				class="flex w-full min-w-0 items-center rounded-item px-2 py-1 text-left transition-colors duration-150 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
				aria-label={valueLabel}
				onclick={startEditing}
			>
				{@render reading()}
			</button>
		{/if}
	{:else}
		<!-- The editor is a popover over the panel, so opening it moves nothing around it. -->
		<Popover.Root open={editing} onOpenChange={setOpen}>
			<!-- Kept raw: the field value is shown as text and edited from it; the ui Button would restyle it. -->
			<Popover.Trigger
				bind:ref={trigger}
				class={cn(
					'flex w-full min-w-0 items-center rounded-item px-2 py-1 text-left transition-colors duration-150 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none',
					editing && 'bg-hover'
				)}
				aria-label={editing ? undefined : valueLabel}
			>
				{@render reading()}
			</Popover.Trigger>
			<Popover.Content
				align="start"
				collisionPadding={8}
				trapFocus={false}
				class={cn('gap-2 p-2', title ? 'w-80' : 'w-72')}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					if (!restoredOpen) focusInput();
				}}
				onCloseAutoFocus={(event) => event.preventDefault()}
				onInteractOutside={(event) => {
					// Clicking away saves what is typed, as moving to another Worker does; a refused
					// write keeps the editor open with its message.
					event.preventDefault();
					void commit(false);
				}}
			>
				{@render form()}
			</Popover.Content>
		</Popover.Root>
	{/if}
{/snippet}

{#if title}
	<h2 class="min-w-0 outline-none" tabindex="-1" data-record-heading>{@render field()}</h2>
{:else}
	{@render field()}
{/if}
