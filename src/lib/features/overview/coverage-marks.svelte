<script lang="ts">
	/**
	 * Committee coverage as marks: a filled mark is a Leader, an open mark is a Leader
	 * still needed. Past the cap the marks would crowd the row, so the same reading is a
	 * fill against the target. The tooltip carries the short reading; the accessible name
	 * may say more.
	 */
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';

	let {
		leaders,
		needed,
		label,
		tooltip = label,
		detail,
		size = 'size-3.5',
		cap = 30
	}: {
		leaders: number;
		needed: number;
		/** The reading in words: the accessible name, and by default the tooltip's first line. */
		label: string;
		/** The tooltip's first line, when it should say less than the accessible name. */
		tooltip?: string;
		/** A second tooltip line, such as the target the marks are measured against. */
		detail?: string;
		size?: string;
		cap?: number;
	} = $props();

	const total = $derived(Math.max(leaders, needed));
	const marks = $derived(Array.from({ length: total <= cap ? total : 0 }, (_, i) => i < leaders));
	const fill = $derived(needed === 0 ? 0 : Math.min(1, leaders / needed));
</script>

<Tooltip.Root>
	<Tooltip.Trigger
		class="inline-flex min-h-4 min-w-0 items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		aria-label={label}
		data-coverage-marks
		data-leaders={leaders}
		data-needed={needed}
		data-short={leaders < needed ? 'true' : undefined}
	>
		{#if total <= cap}
			{#each marks as filled, i (i)}
				<span
					class="{size} shrink-0 rounded-full border border-ink {filled
						? 'bg-ink'
						: 'bg-transparent'}"
					data-mark={filled ? 'leader' : 'needed'}
				></span>
			{/each}
			{#if total === 0}<span class="{size} shrink-0 rounded-full border border-rule"></span>{/if}
		{:else}
			<span
				class="relative block h-2 w-40 max-w-full overflow-hidden rounded-full border border-ink"
			>
				<span class="absolute inset-y-0 start-0 bg-ink" style="width: {fill * 100}%"></span>
			</span>
		{/if}
	</Tooltip.Trigger>
	<Tooltip.Content>
		<p>{tooltip}</p>
		{#if detail}<p class="mt-0.5 text-ink-3">{detail}</p>{/if}
	</Tooltip.Content>
</Tooltip.Root>
