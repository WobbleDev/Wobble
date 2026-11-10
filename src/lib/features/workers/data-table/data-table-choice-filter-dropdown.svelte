<script lang="ts">
	/**
	 * The column filter menu for the Workers table: one checkbox per choice, keyed by its
	 * value (an answer id for an Attribute) and labelled with its text. The shared
	 * filter dropdown keys its options on their text, so the Workers table carries its own.
	 */
	import type { Snippet } from 'svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import type { OptionChoice } from '../answers.ts';
	import { m } from '#lib/paraglide/messages.js';
	import DataTableFilterOptionItems from './data-table-filter-option-items.svelte';

	type Props = {
		label: string;
		options: readonly OptionChoice[];
		/** The values chosen. */
		selected: readonly string[];
		onToggle: (value: string, checked: boolean) => void;
		/** How many Workers hold each value, read when the menu opens. */
		counts?: () => Readonly<Record<string, number>>;
		/** An Assessment is named with its colour dot wherever it is listed. */
		assessment?: boolean;
		/** Replaces the default labelled button, e.g. with a column header's icon. */
		trigger?: Snippet<[{ props: Record<string, unknown> }]>;
	};

	let { label, options, selected, onToggle, counts, assessment = false, trigger }: Props = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			{#if trigger}
				{@render trigger({ props })}
			{:else}
				<Button {...props} variant="outline" size="sm" class="min-h-tap lg:min-h-8">
					{label}
					{#if selected.length}
						<Badge variant="secondary" class="num">{selected.length}</Badge>
					{/if}
				</Button>
			{/if}
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start">
		{#if options.length === 0}
			<DropdownMenu.Group>
				<div class="grid gap-0.5 px-2 py-1.5">
					<p class="text-sm text-muted-foreground">{m.workers_filter_nothing_set_up()}</p>
					<p class="text-sm text-muted-foreground">
						{m.workers_filter_add_in_configuration({ label })}
					</p>
				</div>
			</DropdownMenu.Group>
		{:else}
			<DropdownMenu.Group>
				<DataTableFilterOptionItems {options} {selected} {onToggle} {counts} {assessment} />
			</DropdownMenu.Group>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>
