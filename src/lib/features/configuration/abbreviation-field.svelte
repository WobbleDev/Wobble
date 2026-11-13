<script lang="ts">
	import { Input } from '#lib/components/ui/input/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.ts';
	import { ABBREVIATION_LIMIT, graphemeCount } from '#lib/shared/abbreviation.ts';

	type Props = {
		/** The value's name, for the accessible name. */
		name: string;
		/** What the field shows when it is not being typed in: the edited form or the suggestion. */
		shown: string;
		/** An edited form is drawn normally; a generated one is greyed. */
		edited: boolean;
		disabled: boolean;
		onInput: (text: string) => void;
	};

	let { name, shown, edited, disabled, onInput }: Props = $props();

	/** While the field has focus it shows what is typed, even when that is blank. */
	let typing = $state<string | null>(null);
	const text = $derived(typing ?? shown);
	const count = $derived(graphemeCount(text.trim()));
	const tooLong = $derived(count > ABBREVIATION_LIMIT);

	function giveFocusBack(input: HTMLInputElement) {
		input.closest<HTMLElement>('[role="treeitem"]')?.focus();
	}

	function handleKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
		if (event.key !== 'Enter' && event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		giveFocusBack(event.currentTarget);
	}
</script>

<!-- The count sits inside the field, so showing it moves nothing. -->
<div class="relative w-[7.5rem] shrink-0">
	<Input
		value={text}
		class={cn(
			'h-7 min-h-0 px-2 text-xs coarse:min-h-tap',
			!edited && typing === null && 'text-ink-3',
			(typing !== null || tooLong) && 'pr-9'
		)}
		aria-label={m.configuration_abbreviation_aria({ name })}
		aria-invalid={tooLong || undefined}
		data-testid="abbreviation-field"
		data-origin={edited ? 'edited' : 'generated'}
		data-action="abbreviation"
		tabindex={-1}
		{disabled}
		oninput={(event) => {
			typing = event.currentTarget.value;
			onInput(event.currentTarget.value);
		}}
		onfocus={(event) => event.currentTarget.select()}
		onblur={() => (typing = null)}
		onkeydown={handleKeydown}
	/>
	{#if typing !== null || tooLong}
		<span
			aria-hidden="true"
			data-testid="abbreviation-count"
			class={cn(
				'pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[0.6875rem] tabular-nums',
				tooLong ? 'text-state-error' : 'text-ink-3'
			)}>{count}/{ABBREVIATION_LIMIT}</span
		>
		<span class="sr-only" aria-live="polite"
			>{m.configuration_abbreviation_count({ count, max: ABBREVIATION_LIMIT })}</span
		>
	{/if}
</div>
