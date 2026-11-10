<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { Label } from '#lib/components/ui/label/index.ts';
	import * as Select from '#lib/components/ui/select/index.ts';

	type Props = {
		label: string;
		headers: readonly string[];
		placeholder: string;
		selected: number;
		/** The first cells of the chosen column, so the choice can be checked against the file. */
		samples?: readonly string[];
	};

	let { label, headers, placeholder, selected = $bindable(-1), samples = [] }: Props = $props();
	const id = $props.id();

	const value = $derived(String(selected));

	const items = $derived([
		{ value: '-1', label: placeholder },
		...headers.map((header, index) => ({
			value: String(index),
			label: header
		}))
	]);

	function handleChange(next: string | undefined) {
		const parsed = Number(next);
		selected = Number.isInteger(parsed) ? parsed : -1;
	}
</script>

<div class="grid gap-2">
	<Label for={id}>{label}</Label>
	<Select.Root type="single" {items} {value} onValueChange={handleChange}>
		<Select.Trigger {id} class="min-h-tap w-full sm:min-h-9">
			<Select.Value {placeholder} />
		</Select.Trigger>
		<Select.Content>
			<Select.Group>
				<Select.Item value="-1" label={placeholder}>
					{placeholder}
				</Select.Item>
				{#each headers as header, index (`${index}:${header}`)}
					<Select.Item value={String(index)} label={header}>
						{header}
					</Select.Item>
				{/each}
			</Select.Group>
		</Select.Content>
	</Select.Root>
	{#if samples.length > 0}
		<p class="min-w-0 truncate text-xs text-muted-foreground">
			{m.workers_import_sample({ samples: samples.join(' · ') })}
		</p>
	{/if}
</div>
