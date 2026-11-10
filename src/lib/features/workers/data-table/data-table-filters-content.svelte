<script lang="ts">
	/**
	 * The body of the Filters control: Clear all, a checkbox group for each
	 * filter (Languages, Assessment, every Attribute), plus the column toggles
	 * when `showColumns` is set.
	 * The narrow sheet and the desktop popover both render it, so the two never
	 * fork.
	 */
	import type { Table } from '@tanstack/svelte-table';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { Button } from '#lib/components/ui/button/index.ts';
	import SwatchDot from '#lib/shared/swatch-dot.svelte';
	import { assessmentColorFor, isAssessment } from '#lib/shared/assessment.ts';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import type { DataTableFeatures } from './data-table-features.ts';
	import type { OptionChoice } from '../answers.ts';
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
		visibilityOptions?: readonly { id: string; label: string }[];
		activeCount: number;
		onToggle: (columnId: string, option: string, checked: boolean) => void;
		readFilterValues: (columnId: string) => string[];
		/** Clears every filter group. */
		clearAllFilters: () => void;
		/** Folds the column toggles in; the desktop toolbar gives them their own button. */
		showColumns?: boolean;
	};

	let {
		table,
		groups,
		visibilityOptions = [],
		activeCount,
		onToggle,
		readFilterValues,
		clearAllFilters,
		showColumns = false
	}: Props = $props();
</script>

{#snippet tick(
	option: { label: string; value?: string; description?: string | null; missing?: boolean },
	checked: boolean,
	onChange: (checked: boolean) => void,
	assessment = false
)}
	<!-- Kept raw: a checkbox menu row with the tick at its end; the ui Checkbox draws its own box. -->
	<button
		type="button"
		role="checkbox"
		aria-checked={checked}
		data-missing={option.missing ? 'true' : undefined}
		aria-label={option.description ? `${option.label} (${option.description})` : option.label}
		class="flex min-h-tap w-full items-center justify-between gap-3 rounded-control px-2 text-left text-sm font-medium hover:bg-inset lg:min-h-7"
		onclick={() => onChange(!checked)}
	>
		<span class="flex min-w-0 flex-col">
			<span class="flex min-w-0 items-center gap-2">
				{#if assessment && option.value && isAssessment(option.value)}
					<SwatchDot color={assessmentColorFor(option.value)} />
				{/if}
				<span class="min-w-0">{option.label}</span>
			</span>
			{#if option.description}
				<span class="text-xs font-normal text-muted-foreground">{option.description}</span>
			{/if}
		</span>
		{#if checked}<CheckIcon class="size-4" />{/if}
	</button>
{/snippet}

<Button
	variant="outline"
	class="min-h-tap lg:min-h-8"
	disabled={activeCount === 0}
	onclick={clearAllFilters}
>
	{m.workers_clear_all_filters()}
</Button>
{#each groups as group (group.id)}
	{@const selected = readFilterValues(group.id)}
	<fieldset class="grid gap-1">
		<legend class="text-sm font-medium">{group.label}</legend>
		{#if group.options.length === 0}
			<p class="text-sm text-muted-foreground">
				{m.workers_filter_nothing_set_up()}
				{m.workers_filter_add_in_configuration({ label: group.label })}
			</p>
		{:else}
			{#each group.options as option (option.value)}
				{@render tick(
					option,
					selected.includes(option.value),
					(checked) => onToggle(group.id, option.value, checked),
					group.assessment ?? false
				)}
			{/each}
		{/if}
	</fieldset>
{/each}
{#if showColumns}
	<fieldset class="grid gap-1">
		<legend class="text-sm font-medium">{m.workers_column_columns()}</legend>
		{#each visibilityOptions as option (option.id)}
			{@const column = table.getColumn(option.id)}
			{#if column}
				{@render tick({ label: option.label }, column.getIsVisible(), (checked) =>
					column.toggleVisibility(checked)
				)}
			{/if}
		{/each}
	</fieldset>
{/if}
