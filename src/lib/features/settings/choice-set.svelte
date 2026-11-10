<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import * as Field from '#lib/components/ui/field/index.ts';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.ts';

	let {
		id,
		name,
		options,
		selected,
		apply
	}: {
		/** Stable, untranslated prefix for the option keys' IDs; display copy never names an ID. */
		id: string;
		name: string;
		options: ReadonlyArray<{ value: string; label: string; key: string }>;
		selected: string;
		apply: (value: string) => void;
	} = $props();
</script>

<Field.FieldSet class="px-6 pb-6">
	<Field.FieldLegend class="sr-only">{name}</Field.FieldLegend>
	<ToggleGroup.Root
		type="single"
		spacing={3}
		aria-label={name}
		value={selected}
		onValueChange={apply}
		class="grid w-full grid-cols-1 items-stretch sm:grid-cols-3"
	>
		{#each options as option (option.value)}
			{@const keyId = `${id}-${option.value}-key`}
			<ToggleGroup.Item
				value={option.value}
				aria-describedby={keyId}
				class="group/cell relative flex h-auto min-h-tap min-w-0 flex-col items-start justify-start gap-1 rounded-control border border-rule-strong bg-panel px-4 py-3 text-left whitespace-normal transition-colors duration-150 hover:bg-hover focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid data-[state=on]:border-action data-[state=on]:bg-action data-[state=on]:text-on-action data-[state=on]:hover:bg-action md:min-h-0"
			>
				<Check
					aria-hidden="true"
					class="absolute top-2 right-2 size-4 opacity-0 transition-opacity duration-150 group-data-[state=on]/cell:opacity-100"
				/>
				<span class="text-sm font-medium">{option.label}</span>
				<span id={keyId} class="key group-data-[state=on]/cell:text-on-action">{option.key}</span>
			</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>
</Field.FieldSet>
