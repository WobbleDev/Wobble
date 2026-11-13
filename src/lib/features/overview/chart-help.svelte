<script lang="ts">
	/**
	 * How to read the Assessment bullseye, beside the Overview title.
	 *
	 * The help left the column's foot so the Breakdown keeps its height: it opens
	 * on hover and on focus from a button a keyboard reader reaches. The copy keeps
	 * its two forms — the chart backdrop is dragged and scrolled, the fitted chart only
	 * scrolled — and reads the shell's own view state, so the two can never
	 * disagree about which chart is drawn.
	 */
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { bullseyeView } from '#lib/features/overview/bullseye/bullseye-view.ts';
	import { leaderTarget } from '#lib/features/overview/support-summary.ts';
	import { m } from '#lib/paraglide/messages.js';

	let { committeeGoal = 5 }: { committeeGoal?: number } = $props();
	const view = bullseyeView();
	const perLeader = $derived(leaderTarget(committeeGoal));
</script>

<Tooltip.Root>
	<Tooltip.Trigger
		class="pointer-events-auto inline-flex size-tap shrink-0 items-center justify-center rounded-full text-ink-3 hover:text-ink focus-visible:text-ink lg:size-6"
		aria-label={m.overview_chart_help_label()}
	>
		<CircleHelpIcon class="size-4" aria-hidden="true" />
	</Tooltip.Trigger>
	<Tooltip.Content side="bottom" align="start" class="max-w-xs">
		<p>{view.shown ? m.overview_chart_help_ground() : m.overview_chart_help_fitted()}</p>
		<p class="mt-2 border-t border-rule pt-2">{m.overview_summary_help_support()}</p>
		<p class="mt-1">{m.overview_summary_help_coverage({ count: perLeader })}</p>
	</Tooltip.Content>
</Tooltip.Root>
