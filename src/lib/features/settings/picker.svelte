<script lang="ts">
	import { getContext } from 'svelte';
	import * as Select from '#lib/components/ui/select/index.ts';
	import { labelOf, type Choice } from './choice.ts';
	import { settingsRowContextKey, type SettingsRowContext } from './row-context.ts';

	let {
		rowId,
		choices,
		value,
		onChange,
		width = 'sm:w-64',
		disabled = false
	}: {
		rowId: string;
		choices: Choice[];
		value: string;
		onChange: (value: string) => void;
		width?: string;
		disabled?: boolean;
	} = $props();

	/* Only reference description IDs the row actually renders. */
	const row = getContext<SettingsRowContext | undefined>(settingsRowContextKey);
</script>

<Select.Root type="single" items={choices} {value} onValueChange={onChange} {disabled}>
	<Select.Trigger
		aria-labelledby="{rowId}-title"
		aria-describedby={row?.describedby}
		class="min-h-tap w-full md:min-h-9 {width}"
	>
		<Select.Value>{labelOf(choices, value)}</Select.Value>
	</Select.Trigger>
	<Select.Content>
		<Select.Group>
			{#each choices as choice (choice.value)}
				<Select.Item value={choice.value} label={choice.label}>{choice.label}</Select.Item>
			{/each}
		</Select.Group>
	</Select.Content>
</Select.Root>
