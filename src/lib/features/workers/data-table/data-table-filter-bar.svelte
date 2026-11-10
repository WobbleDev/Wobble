<script lang="ts">
	import type { Table } from '@tanstack/svelte-table';
	import XIcon from '@lucide/svelte/icons/x';
	import {
		assessmentOptions,
		type Agitation,
		type Language,
		type Worker
	} from '#lib/domain-vocabulary.ts';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { answerFilterChoices, assessmentChoices, type OptionChoice } from '../answers.ts';
	import { workerCount as workerCountLabel } from '../copy.ts';
	import { m } from '#lib/paraglide/messages.js';
	import {
		NO_SELECTION_CHOICE,
		readAnswerFilter,
		toggleAnswerFilter,
		withoutExactAnswerFilter
	} from '#lib/shared/worker-filters.ts';
	import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
	import { remainderReading } from '#lib/shared/answer-hierarchy.ts';
	import { noValueReading } from '#lib/shared/no-value-reading.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { getEditModel } from '#lib/features/workers/edit-model.svelte.ts';
	import type { DataTableFeatures } from './data-table-features.ts';
	import DataTableFiltersMenu from './data-table-filters-menu.svelte';
	import DataTableColumnsPopover from './data-table-columns-popover.svelte';
	import DataTableFiltersSheet from './data-table-filters-sheet.svelte';
	import SavedViewsMenu from '#lib/features/saved-views/saved-views-menu.svelte';
	import type { SavedViews } from '#lib/features/saved-views/saved-views.svelte.ts';

	type Props = {
		table: Table<DataTableFeatures, Worker>;
		attributes: readonly WorkerAttributeDefinition[];
		agitations: readonly Agitation[];
		languages: readonly Language[];
		savedViews: SavedViews;
		/** How many Workers the filters match. */
		workerCount: number;
	};

	let { table, attributes, agitations, languages, savedViews, workerCount }: Props = $props();

	const editModel = getEditModel();

	type FilterGroup = {
		id: string;
		label: string;
		options: OptionChoice[];
		/** Attribute groups hold answer ids plus the include-no-selection condition. */
		answers?: boolean;
		/** An Assessment group names each option with its colour dot. */
		assessment?: boolean;
	};

	/** Whether this column's filter holds answer ids plus the no-selection condition. */
	function isAnswerFilter(columnId: string): boolean {
		return attributes.some((attribute) => attribute.id === columnId);
	}

	function readFilterValues(columnId: string): string[] {
		const value = table.getColumn(columnId)?.getFilterValue();
		if (isAnswerFilter(columnId)) {
			const filter = readAnswerFilter(value);
			return filter.missing ? [...filter.answers, NO_SELECTION_CHOICE] : filter.answers;
		}
		return Array.isArray(value)
			? value.filter((option): option is string => typeof option === 'string')
			: [];
	}

	// Search, the worker count and the column toggles stay in the bar. On desktop
	// each filter sits on its column header; on mobile the filters live in the sheet.
	const filterOptions = $derived([
		{
			id: 'languages',
			label: m.workers_column_languages(),
			options: languages.map((language) => ({ value: language.name, label: language.name }))
		},
		{
			id: 'assessment',
			label: m.workers_column_assessment(),
			options: assessmentChoices(assessmentOptions),
			assessment: true
		}
	]);
	const visibilityOptions = $derived([
		{ id: 'assessment', label: m.workers_column_assessment() },
		{ id: 'languages', label: m.workers_column_languages() },
		...table
			.getAllLeafColumns()
			.filter((column) => attributes.some((attribute) => attribute.id === column.id))
			.map((column) => ({ id: column.id, label: column.columnDef.meta?.label ?? column.id }))
	]);
	const filters = $derived(
		filterOptions.map((filter) => ({
			...filter,
			selected: readFilterValues(filter.id)
		}))
	);

	/** The worksite's Agitations by configured text, keyed by their stable ids. */
	const agitationOptions = $derived(
		agitations.map((agitation) => ({ value: agitation.id, label: agitation.text }))
	);
	const groups: FilterGroup[] = $derived([
		...filters,
		{ id: 'agitations', label: m.domain_agitations(), options: agitationOptions },
		...attributes.map((attribute) => ({
			id: attribute.id,
			label: attribute.name,
			// Both cardinalities offer the shared no-value reading beside their answers.
			options: answerFilterChoices(attribute),
			answers: true
		}))
	]);

	type ActiveCondition = {
		columnId: string;
		choice: string;
		label: string;
		description?: string | null;
		missing?: boolean;
		/** The direct-parent remainder reading, never an ordinary subtree selection. */
		exact?: boolean;
	};

	/** Each chosen condition, named the way the Worksite configures it. */
	const activeConditions: ActiveCondition[] = $derived.by(() => {
		const conditions: ActiveCondition[] = [];

		for (const choice of readFilterValues('languages')) {
			conditions.push({ columnId: 'languages', choice, label: choice });
		}
		for (const choice of readFilterValues('assessment')) {
			conditions.push({ columnId: 'assessment', choice, label: choice });
		}
		for (const agitationId of readFilterValues('agitations')) {
			const agitation = agitations.find((entry) => entry.id === agitationId);
			if (agitation) {
				conditions.push({ columnId: 'agitations', choice: agitationId, label: agitation.text });
			}
		}
		for (const attribute of attributes) {
			const filter = readAnswerFilter(table.getColumn(attribute.id)?.getFilterValue());
			for (const answerId of filter.answers) {
				if (attribute.answers.some((entry) => entry.id === answerId)) {
					conditions.push({
						columnId: attribute.id,
						choice: answerId,
						label: answerDisplayLabel(attribute.answers, answerId)
					});
				}
			}
			for (const answerId of filter.exact ?? []) {
				if (!attribute.answers.some((entry) => entry.id === answerId)) continue;
				const reading = remainderReading(attribute, answerId);
				conditions.push({
					columnId: attribute.id,
					choice: answerId,
					label: reading.label,
					description: reading.description,
					exact: true
				});
			}
			if (filter.missing) {
				const reading = noValueReading(attribute);
				conditions.push({
					columnId: attribute.id,
					choice: NO_SELECTION_CHOICE,
					label: reading.label,
					description: reading.description,
					missing: true
				});
			}
		}
		return conditions;
	});

	const activeCount = $derived(activeConditions.length);

	function readNameSearch(): string {
		const value = table.getColumn('name')?.getFilterValue();
		return typeof value === 'string' ? value : '';
	}

	const nameSearch = $derived(readNameSearch());

	function setFilterValue(columnId: string, value: unknown) {
		const column = table.getColumn(columnId);
		if (!column) {
			throw new Error(`Filter column "${columnId}" is not configured.`);
		}

		column.setFilterValue(value);
	}

	function toggleFilter(columnId: string, option: string, checked: boolean) {
		if (isAnswerFilter(columnId)) {
			const column = table.getColumn(columnId);
			if (!column) {
				throw new Error(`Filter column "${columnId}" is not configured.`);
			}
			column.setFilterValue(toggleAnswerFilter(column.getFilterValue(), option, checked));
			return;
		}

		const selected = readFilterValues(columnId);
		const next = checked
			? [...new Set([...selected, option])]
			: selected.filter((value) => value !== option);

		setFilterValue(columnId, next.length ? next : undefined);
	}

	function removeCondition(condition: ActiveCondition) {
		if (condition.exact) {
			const column = table.getColumn(condition.columnId);
			if (!column) return;
			column.setFilterValue(withoutExactAnswerFilter(column.getFilterValue(), condition.choice));
			return;
		}
		toggleFilter(condition.columnId, condition.choice, false);
	}

	function clearAllFilters() {
		for (const group of groups) setFilterValue(group.id, undefined);
	}

	function updateNameSearch(value: string) {
		const column = table.getColumn('name');
		if (!column) {
			throw new Error('Name filter column is not configured.');
		}

		column.setFilterValue(value || undefined);
	}
</script>

<div class="border-b border-rule">
	<div
		data-testid="workers-toolbar"
		class="flex flex-wrap items-center justify-between gap-2 px-3 py-4 lg:px-4"
	>
		<div class="flex min-w-0 flex-1 items-center gap-2 max-lg:contents lg:flex-wrap">
			<Input
				type="search"
				data-worker-search
				aria-label={m.workers_search_name()}
				placeholder={m.workers_search_name()}
				value={nameSearch}
				oninput={(event) => updateNameSearch(event.currentTarget.value)}
				class="order-last min-h-tap w-full min-w-0 basis-full lg:order-none lg:h-8 lg:min-h-8 lg:w-40 lg:basis-auto"
			/>
			<span
				data-testid="worker-count"
				class="num text-sm whitespace-nowrap text-ink-2 max-lg:mr-auto"
			>
				{workerCountLabel(workerCount)}
			</span>
			<DataTableFiltersSheet
				{table}
				{groups}
				{activeCount}
				{visibilityOptions}
				onToggle={toggleFilter}
				{readFilterValues}
				{clearAllFilters}
			/>
		</div>
		<div class="hidden lg:inline-flex">
			<DataTableFiltersMenu
				{groups}
				{readFilterValues}
				{toggleFilter}
				{activeCount}
				{clearAllFilters}
			/>
		</div>
		<SavedViewsMenu views={savedViews} class="hidden shrink-0 lg:inline-flex lg:h-8 lg:min-h-8" />
		<DataTableColumnsPopover {table} {visibilityOptions} />
		<Button
			size="sm"
			class="min-h-tap shrink-0 whitespace-nowrap lg:h-8 lg:min-h-8"
			data-new-worker-trigger
			onclick={() => editModel.requestNewWorker()}
		>
			{m.workers_new_worker()}
		</Button>
	</div>
	{#if activeConditions.length > 0}
		<div
			data-testid="active-conditions"
			class="flex flex-wrap items-center gap-1.5 px-3 pb-3 lg:px-4 lg:pb-4"
		>
			<span class="sr-only">{m.workers_active_filters()}</span>
			{#each activeConditions as condition (condition.columnId + ':' + condition.choice + ':' + (condition.missing ? 'missing' : condition.exact ? 'exact' : 'answer'))}
				<span
					data-testid="active-condition"
					data-column-id={condition.columnId}
					data-choice={condition.choice}
					data-missing={condition.missing ? 'true' : undefined}
					data-exact={condition.exact ? 'true' : undefined}
					class="inline-flex items-center gap-1 rounded-full border border-rule bg-inset py-0.5 pr-0.5 pl-2 text-xs"
				>
					<span class="font-medium">{condition.label}</span>
					{#if condition.description}
						<span class="text-muted-foreground">({condition.description})</span>
					{/if}
					<button
						type="button"
						class="rounded-full p-0.5 text-muted-foreground hover:bg-ink/10 hover:text-ink"
						aria-label={m.workers_remove_condition({
							label:
								condition.label + (condition.description ? ' (' + condition.description + ')' : '')
						})}
						onclick={() => removeCondition(condition)}
					>
						<XIcon class="size-3" />
					</button>
				</span>
			{/each}
			<Button variant="ghost" size="sm" class="min-h-tap lg:min-h-8" onclick={clearAllFilters}>
				{m.workers_clear_filters()}
			</Button>
		</div>
	{/if}
</div>
