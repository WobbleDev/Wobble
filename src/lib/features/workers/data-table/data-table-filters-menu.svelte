<script lang="ts">
	/**
	 * The desktop toolbar Filters menu: one submenu per filter group (Languages,
	 * Assessment, Agitations, every Attribute). It reads and writes the same column
	 * filter state as the column header menus, so the two stay in step.
	 */
	import FunnelIcon from '@lucide/svelte/icons/funnel';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import type { OptionChoice } from '../answers.ts';
	import { m } from '#lib/paraglide/messages.js';
	import DataTableFilterOptionItems from './data-table-filter-option-items.svelte';

	type FilterGroup = {
		id: string;
		label: string;
		options: readonly OptionChoice[];
		/** An Assessment group names each option with its colour dot. */
		assessment?: boolean;
	};

	type Props = {
		groups: readonly FilterGroup[];
		readFilterValues: (columnId: string) => string[];
		toggleFilter: (columnId: string, option: string, checked: boolean) => void;
		/** How many conditions are chosen across every group. */
		activeCount: number;
		clearAllFilters: () => void;
	};

	let { groups, readFilterValues, toggleFilter, activeCount, clearAllFilters }: Props = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				size="sm"
				aria-label={m.workers_filter_menu_aria({ count: activeCount })}
				class="min-h-tap gap-1.5 lg:min-h-8"
			>
				<FunnelIcon class="size-3" />
				{m.workers_filters()}
				{#if activeCount}
					<Badge variant="secondary" class="num">{activeCount}</Badge>
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end">
		{#each groups as group (group.id)}
			{@const selected = readFilterValues(group.id)}
			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger>
					<span>{group.label}</span>
					{#if selected.length}
						<Badge variant="secondary" class="num ml-auto">{selected.length}</Badge>
					{/if}
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent>
					{#if group.options.length === 0}
						<div class="grid gap-0.5 px-2 py-1.5">
							<p class="text-sm text-muted-foreground">{m.workers_filter_nothing_set_up()}</p>
							<p class="text-sm text-muted-foreground">
								{m.workers_filter_add_in_configuration({ label: group.label })}
							</p>
						</div>
					{:else}
						<DropdownMenu.Group>
							<DataTableFilterOptionItems
								options={group.options}
								{selected}
								onToggle={(value, checked) => toggleFilter(group.id, value, checked)}
								assessment={group.assessment}
							/>
						</DropdownMenu.Group>
					{/if}
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>
		{/each}
		{#if activeCount > 0}
			<DropdownMenu.Separator />
			<DropdownMenu.Item onSelect={clearAllFilters}>
				{m.workers_clear_filters()}
			</DropdownMenu.Item>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>
