<script lang="ts">
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import GroupPager from './group-pager.svelte';
	import {
		cellShade,
		cellTone,
		heatRatio,
		toneClass,
		type DashboardTheme
	} from './overview-dashboard-presentation.ts';
	import type { createOverviewAgitationsCard } from './overview-agitations-card.svelte.ts';
	import { scrollHint } from './overview-scroll-hint.ts';
	import { matrixAllHref, matrixCellHref } from './summary-links.ts';

	let {
		card,
		matrix,
		attribute,
		attributes,
		workerCount,
		theme
	}: {
		card: ReturnType<typeof createOverviewAgitationsCard>;
		matrix: { columns: { id: string; text: string; count: number }[]; max: number };
		attribute: { name: string } | undefined;
		attributes: readonly WorkerAttributeDefinition[];
		workerCount: number;
		theme: DashboardTheme;
	} = $props();

	const agitationsDescriptionId = $props.id();
	const heat = (count: number) => heatRatio(count, matrix.max);
	let agitationScroller: HTMLElement | undefined = $state();

	// The single reset effect: a grouping move returns to the first page.
	$effect(() => {
		card.syncGrouping();
	});

	$effect(() => card.observeHeaders(agitationScroller));

	/* Refit when font measurement changes the column minimum. Both observers
	   watch the fixed scroller, never the table that paging itself renders. */
	$effect(() => card.observeFit(agitationScroller));
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
	class="panel relative col-span-2 flex min-h-0 flex-col"
	aria-label={m.overview_tab_agitations()}
	onkeydown={card.paging.handleKeydown}
	data-agitations-ready={card.paging.ready}
>
	<div
		class="flex min-h-tap shrink-0 items-center justify-between gap-3 lg:min-h-8"
		class:agitations-inline-title={matrix.columns.length > 0}
	>
		<div class="flex shrink-0 items-center gap-1">
			<h2 class="section-title">{m.overview_tab_agitations()}</h2>
			<Tooltip.Root
				><Tooltip.Trigger
					class="pointer-events-auto inline-flex size-tap shrink-0 items-center justify-center rounded-full text-ink-3 hover:text-ink focus-visible:text-ink lg:size-6"
					aria-label={m.overview_agitations_help_label()}
					><CircleHelpIcon class="size-4" aria-hidden="true" /></Tooltip.Trigger
				><Tooltip.Content side="bottom" align="start" class="max-w-xs flex-col items-start gap-2"
					><p>{m.overview_agitations_summary({ attribute: attribute?.name ?? '' })}</p>
					<p>{m.overview_agitations_help()}</p></Tooltip.Content
				></Tooltip.Root
			>
		</div>
	</div>
	{#if matrix.columns.length === 0}
		<p class="mt-2 text-sm text-ink-3">
			{!attribute ? m.overview_no_grouping_message() : m.overview_no_agitations()}
		</p>
	{:else}
		<p id={agitationsDescriptionId} class="sr-only">
			{m.overview_agitations_summary({ attribute: attribute?.name ?? '' })}
		</p>
		{#snippet agitationColumns()}
			<colgroup
				><col class="agitation-name-column" /><col
					class="w-18"
				/>{#each card.visibleRows as row (row.answerId)}<col />{/each}{#if card.shortPage}<col
						span={card.paging.groupsPerPage - card.visibleRows.length}
					/>{/if}</colgroup
			>
		{/snippet}
		{#snippet agitationHeaders(semantic = false)}
			<thead>
				<tr>
					<th></th>
					<th class="label text-center align-bottom leading-tight"
						><span
							class="flex min-h-6 items-end justify-center pb-1 lg:min-h-8 lg:items-center lg:pb-0"
							>{m.overview_dashboard_all()} ({workerCount})</span
						></th
					>
					{#each card.visibleRows as row (row.answerId)}
						{@const label = card.headers.pageLabels.get(row.answerId) ?? row.value}
						<th
							class="agitation-group-header label px-1 text-center align-bottom leading-tight"
							title={row.value}
						>
							<div
								class="flex min-h-6 items-end justify-center pb-1 lg:min-h-8 lg:items-center lg:pb-0"
							>
								{#if !semantic && label !== row.value}
									<Tooltip.Root>
										<Tooltip.Trigger
											aria-label={`${row.value} (${row.workers})`}
											class="inline-flex max-w-full min-w-0 items-baseline gap-1 rounded-sm uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
										>
											<span
												class="min-w-0 [overflow-wrap:anywhere] whitespace-normal"
												data-group-name>{label}</span
											>
											<span class="shrink-0 whitespace-nowrap">({row.workers})</span>
										</Tooltip.Trigger>
										<Tooltip.Content>{row.value}</Tooltip.Content>
									</Tooltip.Root>
								{:else}
									<span class="inline-flex max-w-full min-w-0 items-baseline gap-1">
										<span class="min-w-0 [overflow-wrap:anywhere] whitespace-normal" data-group-name
											>{semantic ? row.value : label}</span
										><span class="shrink-0 whitespace-nowrap">({row.workers})</span>
									</span>
								{/if}
							</div>
						</th>
					{/each}
				</tr>
			</thead>
		{/snippet}
		<div
			class="mt-2 flex min-h-0 flex-1 flex-col lg:mt-0"
			style:--agitation-group-width={`${card.headers.width}px`}
			style:--agitation-group-available={`${card.headers.availableWidth}px`}
			bind:this={agitationScroller}
		>
			<table
				role="presentation"
				data-agitations-headers
				class="agitations-matrix w-full shrink-0 table-fixed border-separate border-spacing-x-1 border-spacing-y-1 text-sm lg:mb-2 lg:border-spacing-y-0"
			>
				{@render agitationColumns()}
				{@render agitationHeaders()}
			</table>
			<!-- The frame's hairlines mark the scrollport edges in every state;
			     the rows bounce locally inside it (the global contain rule). -->
			<div
				class="flex min-h-0 flex-1 flex-col border-t border-rule"
				class:border-b={!card.showFooter}
			>
				<div
					class="scroll-hint min-h-0 flex-1 overflow-x-clip overflow-y-auto"
					data-scroll-region
					{@attach scrollHint}
				>
					<table
						aria-describedby={agitationsDescriptionId}
						class="agitations-matrix agitations-body w-full table-fixed border-separate border-spacing-x-1 border-spacing-y-1 text-sm"
					>
						{@render agitationColumns()}
						{@render agitationHeaders(true)}
						<tbody>
							{#each matrix.columns as column, i (column.id)}
								<tr class="h-8">
									<th
										class="min-w-0 py-1.5 pr-3 text-left font-normal [overflow-wrap:anywhere] whitespace-normal"
										title={column.text}>{column.text}</th
									>
									<td class="rounded-[3px] text-center font-mono font-medium tabular-nums"
										><a
											href={matrixAllHref(column.id, attributes)}
											aria-label={(column.count === 1
												? m.overview_agitations_all_link_one
												: m.overview_agitations_all_link_other)({
												count: column.count,
												agitation: column.text
											})}
											class="flex h-full w-full items-center justify-center rounded-[inherit] text-inherit hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
											>{column.count}</a
										></td
									>
									{#each card.visibleRows as row (row.answerId)}
										{@const n = row.counts[i]}
										<td
											class="rounded-[3px] text-center font-mono tabular-nums {toneClass(
												cellTone(heat(n), theme),
												''
											)}"
											style="background: {cellShade(heat(n))}"
											>{#if n > 0}<a
													href={matrixCellHref(row, column.id, attributes)}
													aria-label={(n === 1
														? m.overview_agitations_group_link_one
														: m.overview_agitations_group_link_other)({
														count: n,
														agitation: column.text,
														group: row.value
													})}
													class="flex h-full w-full items-center justify-center rounded-[inherit] text-inherit hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
													>{n}</a
												>{:else}{n}{/if}</td
										>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	{/if}
	{#if card.showFooter}
		<div class="shrink-0" data-agitations-page-controls>
			<GroupPager
				{...card.range}
				page={card.currentPage}
				pageCount={card.pageCount}
				previousLabel={m.overview_agitations_prev_label()}
				nextLabel={m.overview_agitations_next_label()}
				pageLabel={m.overview_agitations_page_label()}
				onprevious={(button) => card.paging.goTo(card.currentPage - 1, button)}
				onnext={(button) => card.paging.goTo(card.currentPage + 1, button)}
			/>
		</div>
	{/if}
</section>

<style>
	/* On desktop the title uses the matrix's row-name track, so the column
	   labels and both cards' dividers share one header row. Narrow cards keep
	   the title above the columns to leave its help control room to breathe. */
	@media (width >= 64rem) {
		.agitations-inline-title {
			position: absolute;
			inset-block-start: 1rem;
			inset-inline-start: 1.125rem;
			z-index: 1;
		}
	}
	.agitations-matrix td {
		position: relative;
	}
	.agitations-matrix td > a {
		position: absolute;
		inset: 0;
	}
	.agitation-name-column {
		width: 30%;
	}
	/* Group columns are content-sized from the abbreviated headers: compact labels peak
	   at the abbreviation budget, so the measured reserve binds and this floor only guards
	   the pre-measure transient and degenerate-short datasets. The full-name 10rem desktop
	   minimum would leave every abbreviated column mostly empty. */
	.agitation-group-header {
		min-width: min(max(5rem, var(--agitation-group-width)), var(--agitation-group-available));
	}
	/* The visible header is outside the row scroller. Keep semantic column
	   headers in the data table without reserving another visible header row. */
	.agitations-body :global(thead) {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
	/* A clipped edge fades through 14px so a cut-off row reads as more to reach.
	   The attachment marks the edges with more beyond them; the attribute
	   selectors stay global so Svelte scoping does not break them. */
	.scroll-hint {
		--fade: 0.875rem;
		--l: 0px;
		--r: 0px;
		--t: 0px;
		--b: 0px;
		mask-image:
			linear-gradient(to right, transparent, #000 var(--l)),
			linear-gradient(to left, transparent, #000 var(--r)),
			linear-gradient(to bottom, transparent, #000 var(--t)),
			linear-gradient(to top, transparent, #000 var(--b));
		mask-composite: intersect;
	}
	:global(.scroll-hint[data-left='true']) {
		--l: var(--fade);
	}
	:global(.scroll-hint[data-right='true']) {
		--r: var(--fade);
	}
	:global(.scroll-hint[data-top='true']) {
		--t: var(--fade);
	}
	:global(.scroll-hint[data-bottom='true']) {
		--b: var(--fade);
	}
</style>
