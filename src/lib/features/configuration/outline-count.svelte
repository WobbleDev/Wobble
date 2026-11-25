<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.ts';

	/**
	 * One count cell of the outline. The number is what a sighted organizer compares;
	 * the hidden text is what a screen reader says, because a bare number on its own
	 * does not say what it counts.
	 */
	type Props = {
		count: number;
		testId?: string;
		/** Overrides the default colour and size, e.g. a quieter count in the Attribute list. */
		class?: string;
	};

	let { count, testId = 'worker-count', class: className }: Props = $props();

	const label = $derived(
		count ? m.configuration_count_workers({ count }) : m.configuration_count_workers_none()
	);
</script>

<span
	data-testid={testId}
	data-count={count}
	class={cn('num block text-right text-sm text-ink-2 tabular-nums', className)}
>
	<span aria-hidden="true">{count || '—'}</span>
	<span class="sr-only">{label}</span>
</span>
