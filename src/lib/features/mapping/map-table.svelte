<script lang="ts">
	import type { Language, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { assessmentLabel } from '#lib/i18n/assessment.ts';
	import { m } from '#lib/paraglide/messages.js';
	import * as Table from '#lib/components/ui/table/index.ts';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import {
		mapTableRows,
		sortMapTableRows,
		type MapTableRow,
		type MapTableSort
	} from './map-table-model.ts';
	import type { GroupingReading } from './map-grouping.ts';
	import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';

	type Props = {
		nodes: readonly WorkerGraphNode[];
		links: readonly WorkerGraphLink[];
		groupingAttribute?: WorkerAttributeDefinition;
		subGroupingAttribute?: WorkerAttributeDefinition;
		/** The Grouping's reading: membership, labels and collision descriptions. */
		reading?: GroupingReading;
		/** The Worksite's Languages, in vocabulary order, for the readable equivalent. */
		languages: readonly Language[];
		/** The Workers a complete Highlight query selects; undefined when there is no complete query. */
		highlightIds: ReadonlySet<string> | undefined;
		selectedId: string;
		onSelect: (id: string) => void;
	};

	let {
		nodes,
		links,
		groupingAttribute,
		subGroupingAttribute,
		reading,
		languages,
		highlightIds,
		selectedId,
		onSelect
	}: Props = $props();
	let sort = $state<MapTableSort>({ column: 'name', direction: 'asc' });
	const rows = $derived(
		sortMapTableRows(
			mapTableRows(
				nodes,
				links,
				groupingAttribute,
				subGroupingAttribute,
				languages,
				highlightIds,
				reading
			),
			sort
		)
	);
	const columns = $derived([
		{ key: 'name', label: m.domain_worker() },
		{ key: 'assessment', label: m.mapping_table_assessment() },
		{ key: 'relationships', label: m.domain_relationships() },
		...(languages.length > 0 ? [{ key: 'languages', label: m.domain_languages() }] : []),
		...(groupingAttribute ? [{ key: 'group', label: groupingAttribute.name }] : []),
		...(subGroupingAttribute ? [{ key: 'subGroup', label: subGroupingAttribute.name }] : []),
		...(groupingAttribute
			? [{ key: 'tiesOutsideGroup', label: m.mapping_table_ties_outside() }]
			: []),
		{ key: 'tiesToLeaders', label: m.mapping_table_ties_leaders() }
	] as const);

	function ariaSort(column: MapTableSort['column']) {
		return sort.column !== column ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending';
	}
	function sortBy(column: MapTableSort['column']) {
		sort = {
			column,
			direction: sort.column === column && sort.direction === 'asc' ? 'desc' : 'asc'
		};
	}
	function value(row: MapTableRow, key: string): string | number {
		return row[key as keyof MapTableRow] as string | number;
	}
</script>

<section
	aria-label={m.mapping_map_table()}
	id="mapping-table"
	tabindex="-1"
	data-testid="mapping-table"
	data-scroll-region
	class="sr-only [&_[data-slot=table-container]]:overflow-visible"
>
	{#if rows.length === 0}
		<p class="p-4 text-center text-sm text-ink-3">{m.mapping_no_workers_filters()}</p>
	{:else}
		<Table.Root>
			<Table.Caption class="sr-only [&_[data-slot=table-container]]:overflow-visible"
				>{m.mapping_table_caption()}</Table.Caption
			>
			<Table.Header class="sticky top-0 z-10 bg-panel">
				<Table.Row>
					{#each columns as column (column.key)}
						{@const key = column.key as MapTableSort['column']}
						<Table.Head aria-sort={ariaSort(key)} class="whitespace-nowrap">
							<!-- Kept raw: a sort control in a table header that keeps the header's own type and colour, which the ui Button would override. -->
							<button
								type="button"
								tabindex="-1"
								class="w-full text-left hover:text-ink focus-visible:outline-2 focus-visible:outline-ring"
								onclick={() => sortBy(key)}
							>
								{column.label}
								{#if sort.column === key}<span aria-hidden="true"
										>{sort.direction === 'asc' ? ' ↑' : ' ↓'}</span
									>{/if}
							</button>
						</Table.Head>
					{/each}
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each rows as row (row.id)}
					<Table.Row
						aria-selected={selectedId === row.id}
						data-map-table-row={row.id}
						class="cursor-pointer aria-selected:bg-inset"
						onclick={() => onSelect(row.id)}
					>
						{#each columns as column (column.key)}
							<Table.Cell class="whitespace-nowrap">
								{#if column.key === 'assessment'}
									{assessmentLabel(row.assessment)}
								{:else}
									{value(row, column.key)}{#if column.key === 'name' && row.matchesHighlight}
										<Badge variant="secondary" class="ml-2" data-testid="highlight-match-tag"
											>{m.mapping_table_matches_highlight()}</Badge
										>{/if}{#if column.key === 'group' && row.groupDescription}<span
											class="text-ink-3"
										>
											· {row.groupDescription}</span
										>{:else if column.key === 'subGroup' && row.subGroupDescription}<span
											class="text-ink-3"
										>
											· {row.subGroupDescription}</span
										>{/if}
								{/if}
							</Table.Cell>
						{/each}
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	{/if}
</section>
