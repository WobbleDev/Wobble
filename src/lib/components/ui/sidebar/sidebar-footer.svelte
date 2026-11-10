<script lang="ts">
	import { Separator } from '#lib/components/ui/separator/index.ts';
	import { cn, type WithElementRef } from '#lib/utils.ts';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<footer
	bind:this={ref}
	data-slot="sidebar-footer"
	data-sidebar="footer"
	class={cn('flex shrink-0 flex-col gap-2 p-2', className)}
	{...restProps}
>
	<Separator decorative />
	{@render children?.()}
</footer>
