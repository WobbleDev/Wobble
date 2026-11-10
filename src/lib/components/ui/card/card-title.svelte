<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.ts';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLHeadingElement>> = $props();
</script>

<!-- A card title is a section heading, not a styled div: the document outline
     is what a screen reader navigates by. Every card sits under a page h1.
     The Title role lives here, once: panel titles had drifted between 12.5px
     medium, 13px medium and 13px semibold, so no two panels agreed. -->
<h2
	bind:this={ref}
	data-slot="card-title"
	class={cn('text-lg font-semibold tracking-title', className)}
	{...restProps}
>
	{@render children?.()}
</h2>
