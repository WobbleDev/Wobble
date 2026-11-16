<script lang="ts">
	/**
	 * A tooltip for an icon-only control. The tip repeats the control's own
	 * accessible name, so sighted hover and assistive tech read the same words;
	 * the delay is the app-level provider's.
	 */
	import type { Snippet } from 'svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';

	let {
		label,
		side = 'bottom',
		child
	}: {
		label: string;
		side?: 'top' | 'bottom' | 'left' | 'right';
		/** Renders the control, spreading the trigger's props onto it. */
		child: Snippet<[{ props: Record<string, unknown> }]>;
	} = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger {child} />
	<Tooltip.Content {side}>{label}</Tooltip.Content>
</Tooltip.Root>
