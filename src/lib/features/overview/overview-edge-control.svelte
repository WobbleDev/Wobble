<script lang="ts">
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { bullseyeView } from './bullseye/bullseye-view.ts';
	import { overviewFocus } from './overview-focus.svelte.ts';

	/* The shell's focus and zoom, shared through context: the focus tab and the
	   focused chart backdrop's Reset zoom are the Overview's controls over the chart backdrop, so
	   they live with the Overview rather than in the shell. */
	const focus = overviewFocus();
	const view = bullseyeView();
</script>

<!-- The focus tab: a 24x80 strip at the vertical centre of the right edge,
     above both layers and never inside an inert region, so it answers in
     either state. Toggling keeps keyboard focus on the button itself. -->
<button
	type="button"
	data-focus-edge
	class="absolute top-1/2 right-0 z-[4] flex h-20 w-6 -translate-y-1/2 items-center justify-center rounded-l-md border border-r-0 border-rule bg-panel/70 text-ink-3 backdrop-blur-sm transition-colors hover:bg-panel hover:text-ink focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
	aria-pressed={focus.focused}
	aria-label={focus.focused ? m.overview_show_dashboard() : m.overview_focus_bullseye()}
	onclick={() => focus.toggle()}
>
	{#if focus.focused}<ChevronRightIcon class="size-4" />{:else}<ChevronLeftIcon
			class="size-4"
		/>{/if}
</button>
<!-- Reset zoom belongs to the focused chart backdrop, at the lower right above it;
     the fitted chart keeps its own reset in the page. -->
{#if focus.focused}
	<Button
		variant="outline"
		size="sm"
		data-focus-reset
		class="fixed right-6 bottom-6 z-[4]"
		disabled={view.zoom === 1}
		onclick={() => view.setZoom(1)}
	>
		{m.overview_reset_zoom()}
	</Button>
{/if}
