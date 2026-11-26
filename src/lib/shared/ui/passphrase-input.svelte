<script lang="ts">
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';

	/**
	 * A passphrase field with its own Show toggle. Wobble has no recovery key, so the
	 * reader can check what they typed without choosing the field again. The caller
	 * supplies the toggle label so a screen that can switch language rebuilds it.
	 */
	type Props = Omit<HTMLInputAttributes, 'type' | 'value' | 'files'> & {
		id: string;
		showLabel: string;
		value?: string;
		ref?: HTMLInputElement | null;
	};

	let {
		id,
		showLabel,
		value = $bindable(''),
		ref = $bindable(null),
		disabled = false,
		'aria-invalid': ariaInvalid,
		'aria-describedby': ariaDescribedBy,
		...restProps
	}: Props = $props();

	let visible = $state(false);
</script>

<div class="relative">
	<Input
		bind:ref
		{id}
		type={visible ? 'text' : 'password'}
		bind:value
		{disabled}
		aria-invalid={ariaInvalid}
		aria-describedby={ariaDescribedBy}
		autocomplete="off"
		autocapitalize="off"
		spellcheck={false}
		class="pr-11 md:pr-10"
		{...restProps}
	/>
	<Button
		type="button"
		variant="ghost"
		size="icon"
		class="absolute top-1/2 right-0.5 size-tap -translate-y-1/2 text-ink-2 md:size-8"
		aria-label={showLabel}
		aria-pressed={visible}
		aria-controls={id}
		{disabled}
		onclick={() => (visible = !visible)}
	>
		{#if visible}
			<EyeOff />
		{:else}
			<Eye />
		{/if}
	</Button>
</div>
