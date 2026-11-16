<script lang="ts">
	/**
	 * The small colour dot that stands for an Assessment or an Attribute value.
	 */
	import { cn } from '#lib/utils.ts';

	/**
	 * The design system's Assessment marker: a colour dot beside a label.
	 */
	let { color, class: className }: { color: string; class?: string } = $props();
</script>

<span
	aria-hidden="true"
	class={cn('size-2 shrink-0 rounded-full', className)}
	style={`background-color: ${color}`}
></span>
