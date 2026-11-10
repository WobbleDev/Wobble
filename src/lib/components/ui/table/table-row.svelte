<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.ts';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLTableRowElement>> = $props();
</script>

<tr
	bind:this={ref}
	data-slot="table-row"
	class={cn(
		'h-(--row-h) border-b border-rule transition-colors hover:bg-hover has-aria-expanded:bg-inset data-[state=selected]:bg-inset',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</tr>
