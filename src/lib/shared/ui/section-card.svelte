<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.ts';

	/*
	 * A recessed panel in the work pad: the surface that Configuration sections and
	 * the Worksite danger zone stack. The panel class string lives here once, so
	 * every section keeps the same padding, radius and surface shadow.
	 */
	let {
		class: className,
		children,
		...restProps
	}: HTMLAttributes<HTMLElement> & { children: Snippet } = $props();
</script>

<section
	class={cn('grid gap-4 rounded-surface bg-panel p-6 shadow-surface', className)}
	{...restProps}
>
	{@render children()}
</section>
