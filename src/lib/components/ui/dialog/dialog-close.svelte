<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import {
		buttonVariants,
		type ButtonVariant,
		type ButtonSize
	} from '#lib/components/ui/button/index.ts';
	import { cn } from '#lib/utils.ts';

	// A dialog's dismiss action is a control like any other: an Outline button at
	// the shared height, not a bare button element that inherits nothing but the
	// browser's own 18px-tall default.
	let {
		ref = $bindable(null),
		class: className,
		variant = 'outline',
		size = 'default',
		type = 'button',
		...restProps
	}: DialogPrimitive.CloseProps & {
		variant?: ButtonVariant;
		size?: ButtonSize;
	} = $props();
</script>

<DialogPrimitive.Close
	bind:ref
	data-slot="dialog-close"
	{type}
	class={cn(buttonVariants({ variant, size }), 'min-h-tap md:min-h-8', className)}
	{...restProps}
/>
