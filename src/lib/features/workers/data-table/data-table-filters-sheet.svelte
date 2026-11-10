<script lang="ts">
	/**
	 * The narrow-width Filters control: Languages, Assessment, every Attribute
	 * filter and the column toggles folded into one sheet, so the toolbar stays
	 * on one line. Above the `lg` breakpoint the same body shows in a popover
	 * instead and this control is hidden.
	 *
	 * Filter state lives in the table's columns, so closing the sheet loses
	 * nothing.
	 */
	import type { Table } from '@tanstack/svelte-table';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Sheet from '#lib/components/ui/sheet/index.ts';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import type { DataTableFeatures } from './data-table-features.ts';
	import type { OptionChoice } from '../answers.ts';
	import DataTableFiltersContent from './data-table-filters-content.svelte';
	import { m } from '#lib/paraglide/messages.js';

	type Props = {
		table: Table<DataTableFeatures, Worker>;
		groups: readonly {
			id: string;
			label: string;
			options: readonly OptionChoice[];
			/** An Assessment group names each option with its colour dot. */
			assessment?: boolean;
		}[];
		activeCount: number;
		visibilityOptions: readonly { id: string; label: string }[];
		onToggle: (columnId: string, option: string, checked: boolean) => void;
		readFilterValues: (columnId: string) => string[];
		clearAllFilters: () => void;
	};

	let {
		table,
		groups,
		activeCount,
		visibilityOptions,
		onToggle,
		readFilterValues,
		clearAllFilters
	}: Props = $props();
</script>

<Sheet.Root>
	<Sheet.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" class="min-h-tap shrink-0 lg:hidden">
				{m.workers_filters()}
				{#if activeCount > 0}
					<Badge variant="secondary" class="num">{activeCount}</Badge>
				{/if}
			</Button>
		{/snippet}
	</Sheet.Trigger>
	<Sheet.Content side="bottom" class="max-h-[85vh] overflow-y-auto">
		<Sheet.Header>
			<Sheet.Title>{m.workers_filters()}</Sheet.Title>
			<Sheet.Description>{m.workers_filters_description()}</Sheet.Description>
		</Sheet.Header>
		<div class="grid gap-4 px-4 pb-4">
			<DataTableFiltersContent
				{table}
				{groups}
				{visibilityOptions}
				{activeCount}
				{onToggle}
				{readFilterValues}
				{clearAllFilters}
				showColumns
			/>
		</div>
	</Sheet.Content>
</Sheet.Root>
