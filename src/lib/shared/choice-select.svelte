<script lang="ts">
	import * as Select from '#lib/components/ui/select/index.ts';
	import { cn } from '#lib/utils.ts';

	/**
	 * A single choice from a short list, built on the shared Select. `''` means nothing is
	 * chosen yet and shows the placeholder, so an option that stands for "none" needs a
	 * real value of its own.
	 */
	type Item = { value: string; label: string };
	type Props = {
		items: readonly Item[];
		value?: string;
		placeholder?: string;
		id?: string;
		'aria-label'?: string;
		'data-testid'?: string;
		disabled?: boolean;
		class?: string;
		onChange?: (value: string) => void;
	};

	let {
		items,
		value = $bindable(''),
		placeholder = '',
		id,
		'aria-label': ariaLabel,
		'data-testid': testId,
		disabled = false,
		class: className,
		onChange
	}: Props = $props();
</script>

<Select.Root
	type="single"
	items={[...items]}
	{value}
	{disabled}
	onValueChange={(next) => {
		value = next;
		onChange?.(next);
	}}
>
	<Select.Trigger
		{id}
		type="button"
		role="combobox"
		aria-label={ariaLabel}
		data-testid={testId}
		data-value={value}
		class={cn('min-h-tap w-full min-w-0 md:min-h-(--control-h)', className)}
	>
		<Select.Value {placeholder} />
	</Select.Trigger>
	<Select.Content>
		<Select.Group>
			{#each items as item (item.value)}
				<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
			{/each}
		</Select.Group>
	</Select.Content>
</Select.Root>
