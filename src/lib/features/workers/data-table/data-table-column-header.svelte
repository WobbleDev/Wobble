<script lang="ts">
	import type { Column } from '@tanstack/svelte-table';
	import type { DataTableFeatures } from './data-table-features.ts';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpDownIcon from '@lucide/svelte/icons/arrow-up-down';
	import FunnelIcon from '@lucide/svelte/icons/funnel';
	import DataTableChoiceFilterDropdown from './data-table-choice-filter-dropdown.svelte';
	import type { OptionChoice } from '../answers.ts';
	import { m } from '#lib/paraglide/messages.js';
	import {
		NO_SELECTION_CHOICE,
		readAnswerFilter,
		toggleAnswerFilter
	} from '#lib/shared/worker-filters.ts';

	let {
		column,
		title,
		filter
	}: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- This shared header accepts columns with different value types (strings, literal unions, etc.).
		column: Column<DataTableFeatures, Worker, any>;
		title: string;
		/** When set, the header offers a filter menu over these options. */
		filter?: {
			options: readonly OptionChoice[];
			assessment?: boolean;
			answers?: boolean;
		};
	} = $props();

	const selected = $derived.by(() => {
		const value = column.getFilterValue();
		if (filter?.answers) {
			const answerFilter = readAnswerFilter(value);
			return answerFilter.missing
				? [...answerFilter.answers, NO_SELECTION_CHOICE]
				: answerFilter.answers;
		}
		return Array.isArray(value)
			? value.filter((option): option is string => typeof option === 'string')
			: [];
	});

	/** Workers per option value, over the whole Workers table rather than the filtered rows. */
	const optionCounts: Record<string, number> = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const row of column.table.getCoreRowModel().rows) {
			const value = row.getValue(column.id);
			for (const option of Array.isArray(value) ? value : [value]) {
				if (typeof option === 'string') counts[option] = (counts[option] ?? 0) + 1;
			}
		}
		return counts;
	});

	function toggleOption(value: string, checked: boolean) {
		if (filter?.answers) {
			column.setFilterValue(toggleAnswerFilter(column.getFilterValue(), value, checked));
			return;
		}

		const next = checked
			? [...new Set([...selected, value])]
			: selected.filter((chosen) => chosen !== value);

		column.setFilterValue(next.length ? next : undefined);
	}
</script>

{#snippet filterMenu()}
	{#if filter}
		<DataTableChoiceFilterDropdown
			label={title}
			options={filter.options}
			{selected}
			onToggle={toggleOption}
			counts={() => optionCounts}
			assessment={filter.assessment}
		>
			{#snippet trigger({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon"
					aria-label={m.workers_filter_aria({ title })}
					aria-pressed={selected.length > 0}
					class={`relative size-7 min-h-tap p-0 hover:bg-ink/10 aria-expanded:bg-ink/10 lg:min-h-7 ${selected.length ? 'text-primary' : 'text-muted-foreground'}`}
				>
					<FunnelIcon class="size-3" />
					{#if selected.length}
						<span class="absolute top-1 right-1 size-1.5 rounded-full bg-primary"></span>
					{/if}
				</Button>
			{/snippet}
		</DataTableChoiceFilterDropdown>
	{/if}
{/snippet}

{#if column.getCanSort()}
	<!-- The label voice, declared here rather than inherited: the button's own
	     size, weight and (from the user agent) case would otherwise win over the
	     header cell's, and a sortable header would not match a fixed one. A
	     sortable header is a column label, so it takes the label role's size and
	     tracking, not the smaller key step a button tends to reach for. -->
	<span class="inline-flex max-w-full min-w-0 items-center gap-0.5">
		<Button
			variant="ghost"
			class="-mx-1.5 h-7 min-h-tap min-w-0 shrink gap-1 px-1.5 font-mono text-xs font-medium tracking-key uppercase lg:min-h-7"
			onclick={column.getToggleSortingHandler()}
		>
			<span class="min-w-0 truncate">{title}</span>
			{#if column.getIsSorted() === 'asc'}
				<ArrowUpIcon class="size-3" data-icon="inline-end" />
			{:else if column.getIsSorted() === 'desc'}
				<ArrowDownIcon class="size-3" data-icon="inline-end" />
			{:else}
				<ArrowUpDownIcon class="size-3" data-icon="inline-end" />
			{/if}
		</Button>
		{#if filter}
			{@render filterMenu()}
		{/if}
	</span>
{:else if filter}
	<span class="inline-flex items-center gap-1">
		{title}
		{@render filterMenu()}
	</span>
{:else}
	{title}
{/if}
