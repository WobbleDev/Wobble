<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.ts';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLParagraphElement>> = $props();
</script>

<p
	bind:this={ref}
	data-slot="field-description"
	class={cn(
		// A short description breaks balanced rather than leaving a stranded last
		// line; balance caps itself, so a long paragraph still reads as prose.
		'text-left text-sm leading-normal font-normal text-balance text-muted-foreground group-has-data-horizontal/field:text-balance [[data-variant=legend]+&]:-mt-1.5',
		'last:mt-0 nth-last-2:-mt-1',
		// A description is read, not scanned: it holds a comfortable measure even
		// where the card it sits in is the full width of a 1440px window.
		'max-w-prose',
		'[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</p>
