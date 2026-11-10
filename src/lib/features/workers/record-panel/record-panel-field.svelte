<script lang="ts">
	/**
	 * One single-line field of the record, edited where it is shown. The value is a
	 * button; clicking it turns the field into a full-width input with Save and
	 * Cancel beneath. Enter or Save commits, Escape or Cancel puts the old value
	 * back, and focus returns to the value button either way.
	 *
	 * A commit that changes nothing sends no request and reports nothing. A commit
	 * the core refuses keeps the editor open with what was typed and says why in
	 * the UI's own words (ADR-0024); the core's message never reaches the screen.
	 */
	import { onMount, tick, untrack } from 'svelte';
	import { formatPhoneDigits, formatPhoneInput, phoneDigits } from '../phone.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { cn } from '#lib/utils.ts';
	import { getEditModel } from '#lib/features/workers/edit-model.svelte.ts';
	import { runSingleEdit } from '../data-table/data-table-bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
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
		draftKey
	}: Props = $props();

	let editing = $state(false);
	let draft = $state('');
	let errorMessage = $state('');
	let saving = $state(false);
	let input = $state<HTMLInputElement | null>(null);
	let trigger = $state<HTMLButtonElement | null>(null);

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

	function startEditing() {
		draft = value;
		errorMessage = '';
		editing = true;
		void tick().then(() => {
			input?.focus();
			input?.select();
		});
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
	async function commit(refocus = true): Promise<boolean> {
		if (saving) return true;

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

{#snippet field()}
	{#if editing}
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
	{:else}
		<!-- Kept raw: the field value is shown as text and edited in place; the ui Button would restyle it. -->
		<button
			type="button"
			bind:this={trigger}
			class="flex w-full min-w-0 items-center rounded-item px-2 py-1 text-left transition-colors duration-150 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
			aria-label={valueLabel}
			onclick={startEditing}
		>
			<span
				class={cn(
					'prose-value min-w-0 break-words',
					title ? 'text-xl font-semibold tracking-title text-pretty' : 'text-sm',
					empty && 'font-normal text-ink-3 underline decoration-dotted underline-offset-4'
				)}
			>
				{value || placeholder}
			</span>
		</button>
	{/if}
{/snippet}

{#if title}
	<h2 class="min-w-0 outline-none" tabindex="-1" data-record-heading>{@render field()}</h2>
{:else}
	{@render field()}
{/if}
