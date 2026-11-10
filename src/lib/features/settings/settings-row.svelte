<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setContext } from 'svelte';
	import { cn } from '#lib/utils.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { settingsRowContextKey, type SettingsRowContext } from './row-context.ts';

	/*
	 * One setting: its name and what it does on the left, its control on
	 * the right. A `stacked` row puts the control under the text for controls that
	 * need the full width (the three-cell choosers, a file path). An `unavailable`
	 * row keeps its control in place but disabled, with "Not available yet" beside
	 * it; the row is marked so acceptance tests can read the capability state, and it
	 * tells its control which description IDs exist, so no control references a
	 * description the row never renders.
	 */
	let {
		id,
		title,
		description,
		stacked = false,
		unavailable = false,
		children
	}: {
		id: string;
		title: string;
		description?: string;
		stacked?: boolean;
		unavailable?: boolean;
		children?: Snippet;
	} = $props();

	/* The description IDs this row actually renders; a control reads it through the row's
	   context instead of guessing an ID that may not exist. */
	const describedby = $derived(
		[description ? `${id}-desc` : '', unavailable ? `${id}-unavailable` : '']
			.filter(Boolean)
			.join(' ') || undefined
	);

	setContext(settingsRowContextKey, {
		get describedby() {
			return describedby;
		}
	} satisfies SettingsRowContext);
</script>

<div
	data-row={id}
	data-unavailable={unavailable ? 'true' : undefined}
	class={cn(
		'grid gap-3 border-t border-rule px-6 py-4',
		!stacked && 'sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-8'
	)}
>
	<div class="grid min-w-0 gap-0.5">
		<p id="{id}-title" class="text-sm font-medium text-ink">{title}</p>
		{#if description}
			<p id="{id}-desc" class="max-w-prose text-sm text-ink-3">{description}</p>
		{/if}
	</div>
	{#if children || unavailable}
		<div class={cn('flex flex-wrap items-center gap-2', !stacked && 'sm:justify-end')}>
			{@render children?.()}
			{#if unavailable}
				<p id="{id}-unavailable" class="text-sm text-ink-3">{m.settings_not_available()}</p>
			{/if}
		</div>
	{/if}
</div>
