<script lang="ts">
	/**
	 * The desktop Columns control, at the right of the toolbar: a tick-list
	 * (as the filter dropdowns) of the optional columns. Below `lg` the same toggles sit in the Filters sheet
	 * and this button is hidden.
	 */
	import type { Table } from '@tanstack/svelte-table';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import type { DataTableFeatures } from './data-table-features.ts';
	import { m } from '#lib/paraglide/messages.js';

	type Props = {
		table: Table<DataTableFeatures, Worker>;
		visibilityOptions: readonly { id: string; label: string }[];
	};

	let { table, visibilityOptions }: Props = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" class="hidden shrink-0 lg:inline-flex">
				{m.workers_column_columns()}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="max-h-[70vh] overflow-y-auto">
		<DropdownMenu.Group aria-label={m.workers_column_columns()}>
			{#each visibilityOptions as option (option.id)}
				{@const column = table.getColumn(option.id)}
				{#if column}
					<DropdownMenu.CheckboxItem
						checked={column.getIsVisible()}
						onCheckedChange={(checked) => column.toggleVisibility(checked === true)}
						closeOnSelect={false}
					>
						{option.label}
					</DropdownMenu.CheckboxItem>
				{/if}
			{/each}
		</DropdownMenu.Group>
	</DropdownMenu.Content>
</DropdownMenu.Root>
