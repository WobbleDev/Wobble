<script lang="ts">
	import { tick } from 'svelte';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { cn } from '#lib/utils.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { ValueTextCheck } from './configuration-draft.ts';

	type Props = {
		/** The chip's visible label, and the value an inline edit starts from. */
		text: string;
		/** Optional full path, kept as on-demand context for the visible value. */
		path?: string;
		/** Accessible name for the text button, e.g. "Edit Pay". */
		editLabel: string;
		/** Accessible name for the remove button, e.g. "Remove Pay". */
		removeLabel: string;
		disabled: boolean;
		/** Draws the destructive edge and marks the chip invalid for assistive technology. */
		error?: boolean;
		/** The step this chip sits on; a chip always takes the opposite one. */
		surface?: 'recess' | 'pad';
		/**
		 * `chip` is the filled, wrapping chip. `row` drops the fill and border for an outline row:
		 * a full-width label with the remove control at the end, both out of the tab order so the
		 * row's tree keeps its single tab stop (the tree clicks them by `data-action`).
		 */
		variant?: 'chip' | 'row';
		/** False when the row draws the remove button itself, in its own column. */
		removable?: boolean;
		/** Highlights only the value text while it is an active placement destination. */
		destination?: boolean;
		onRemove: () => void;
		/**
		 * Applies the edited text when it is new and not blank. A duplicate changes nothing:
		 * the caller opens its merge confirmation from `onDuplicate` instead.
		 */
		onRename: (text: string) => ValueTextCheck;
		/** The edited text matches another value in the list; the caller asks before merging. */
		onDuplicate: (text: string, survivorId: string) => void;
	};

	let {
		text,
		path = '',
		editLabel,
		removeLabel,
		disabled,
		error = false,
		surface = 'recess',
		variant = 'chip',
		removable = true,
		destination = false,
		onRemove,
		onRename,
		onDuplicate
	}: Props = $props();

	const messageId = $props.id();
	let editing = $state(false);
	let draft = $state('');
	let message = $state('');
	let inputRef: HTMLInputElement | null = $state(null);
	let textButton = $state<HTMLButtonElement | null>(null);

	async function startEdit() {
		if (disabled) return;
		draft = text;
		message = '';
		editing = true;
		await tick();
		inputRef?.focus();
		inputRef?.select();
	}

	/** Hands focus back to the text button that replaces the field, which the input unmounts. */
	function restoreEditFocus() {
		void tick().then(() => textButton?.focus());
	}

	function cancelEdit(restoreFocus = false) {
		editing = false;
		message = '';
		if (restoreFocus) restoreEditFocus();
	}

	/** Runs on Enter and on blur. Guarded so a blur after Escape or a commit does nothing. */
	function commitEdit(restoreFocus = false) {
		if (!editing) return;
		const check = onRename(draft.trim());
		if (check.status === 'blank') {
			message = m.configuration_enter_value();
			return;
		}
		editing = false;
		message = '';
		if (check.status === 'duplicate') {
			onDuplicate(draft.trim(), check.survivorId);
			return;
		}
		if (restoreFocus) restoreEditFocus();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			// Inside the add form, Enter would otherwise submit the form and add a value.
			event.preventDefault();
			commitEdit(true);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			cancelEdit(true);
		}
	}
</script>

<!--
  A removable chip whose text is also an inline editor. The text is a real button, so it is
  keyboard reachable and named for screen readers; the edit input takes over that spot while
  it is open. The transparent border is the room an error edge needs, reserved at rest.
-->
<span
	class={cn(
		variant === 'row'
			? 'grid w-full min-w-0 grid-cols-[minmax(0,1fr)] items-center rounded-item border border-transparent text-sm'
			: [
					'inline-flex max-w-full flex-wrap items-center gap-1 rounded-item border border-transparent py-1 pr-1 pl-3 text-sm break-words',
					surface === 'pad' ? 'bg-panel' : 'bg-inset'
				],
		(error || message) && 'border-state-error'
	)}
>
	{#if editing}
		<Input
			bind:ref={inputRef}
			bind:value={draft}
			class={cn(
				'field-sizing-content h-auto min-h-tap border-0 bg-transparent px-1 py-0 shadow-none md:min-h-(--control-h-sm)',
				variant === 'row' ? 'w-full min-w-0' : 'w-auto min-w-24 flex-1'
			)}
			aria-label={m.configuration_rename_value_aria({ text })}
			aria-invalid={Boolean(message) || undefined}
			aria-describedby={message ? messageId : undefined}
			onkeydown={handleKeydown}
			onblur={() => commitEdit()}
		/>
	{:else}
		<!-- Kept raw: an inline text button that wraps and underlines on hover; the ui Button forces nowrap. -->
		<button
			bind:this={textButton}
			type="button"
			class={cn(
				'min-h-tap min-w-0 text-left underline decoration-transparent underline-offset-4 hover:decoration-ink-3 focus-visible:decoration-ink md:min-h-(--control-h-sm)',
				variant === 'row' ? 'w-full truncate' : 'break-words'
			)}
			aria-label={editLabel}
			data-action="edit"
			tabindex={variant === 'row' ? -1 : undefined}
			{disabled}
			onclick={startEdit}
		>
			{#if variant === 'row'}
				<!-- The full text stays on the title and in the DOM while the row shows what fits. -->
				<span
					class={cn('block max-w-full truncate', destination && 'w-fit rounded-sm bg-hover px-1')}
					title={path || text}>{text}</span
				>
			{:else}
				{text}
			{/if}
		</button>
	{/if}
	{#if removable}
		<!-- Kept raw: the ui Button adds a press nudge and a disabled fade that this chip control does not have. -->
		<button
			type="button"
			class="flex size-tap shrink-0 items-center justify-center rounded-item p-0 text-ink-3 hover:bg-state-error/10 hover:text-state-error focus-visible:text-state-error focus-visible:ring-2 focus-visible:ring-ring md:size-(--control-h-sm) coarse:min-h-tap coarse:min-w-tap"
			aria-label={removeLabel}
			title={removeLabel}
			data-action="remove"
			tabindex={variant === 'row' ? -1 : undefined}
			{disabled}
			onclick={onRemove}
		>
			<Trash2Icon class="size-4 md:size-3" />
		</button>
	{/if}
	{#if message}
		<span
			id={messageId}
			class={cn(
				'text-xs text-state-error',
				variant === 'row' ? 'col-span-1' : 'col-span-2 @max-[28rem]:col-span-1'
			)}
			role="alert">{message}</span
		>
	{/if}
</span>
