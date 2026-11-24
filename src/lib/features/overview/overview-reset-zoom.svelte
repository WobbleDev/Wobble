<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { bullseyeView } from './bullseye/bullseye-view.ts';
	import { overviewFocus } from './overview-focus.svelte.ts';

	/* The shell's focus and zoom, shared through context: the focused chart backdrop's
	   Reset zoom is the Overview's control over the chart, so it lives with the Overview
	   rather than in the shell. The way in and out of focus sits on the Committee coverage
	   card and on the My Committee column's head. */
	const focus = overviewFocus();
	const view = bullseyeView();
</script>

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
