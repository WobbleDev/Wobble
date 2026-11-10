<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';

	/**
	 * One count cell of the outline. The number is what a sighted organizer compares;
	 * the hidden text is what a screen reader says, because a bare number on its own
	 * does not say what it counts.
	 */
	type Props = {
		count: number;
		testId?: string;
	};

	let { count, testId = 'worker-count' }: Props = $props();

	const label = $derived(
		count ? m.configuration_count_workers({ count }) : m.configuration_count_workers_none()
	);
</script>

<span
	data-testid={testId}
	data-count={count}
	class="num block text-right text-sm text-ink-2 tabular-nums"
>
	<span aria-hidden="true">{count || '—'}</span>
	<span class="sr-only">{label}</span>
</span>
