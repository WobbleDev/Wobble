<script lang="ts">
	import * as Select from '#lib/components/ui/select/index.ts';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import GroupComparisonDialog from './group-comparison-dialog.svelte';
	import GroupPager from './group-pager.svelte';
	import type { createGroupJump } from './group-jump.svelte.ts';
	import { frontierKey } from './overview-comparison.ts';
	import { pct, type DashboardTheme } from './overview-dashboard-presentation.ts';
	import type { createOverviewBreakdownCard } from './overview-breakdown-card.svelte.ts';
	import type { createOverviewGrouping } from './overview-grouping.svelte.ts';
	import OverviewLevelCounts from './overview-level-counts.svelte';
	import OverviewSegmentBar from './overview-segment-bar.svelte';
	import { groupHref } from './summary-links.ts';
	import type { AgitationMatrixRow, GroupReading } from './support-summary.ts';

	let {
		grouping,
		categories,
		groups,
		matrix,
		worksiteTotal,
		card,
		groupJump,
		theme,
		palette
	}: {
		grouping: ReturnType<typeof createOverviewGrouping<WorkerAttributeDefinition>>;
		categories: readonly WorkerAttributeDefinition[];
		groups: GroupReading[];
		matrix: { columns: { id: string; text: string; count: number }[]; rows: AgitationMatrixRow[] };
		worksiteTotal: number;
		card: ReturnType<typeof createOverviewBreakdownCard>;
		groupJump: ReturnType<typeof createGroupJump>;
		theme: DashboardTheme;
		palette: 'default' | 'colorblind';
	} = $props();

	const attribute = $derived(grouping.attribute);
	const breakdownPaging = $derived(card.paging);
	let breakdownBody: HTMLElement | undefined = $state();
	let breakdownFooter: HTMLElement | undefined = $state();
	$effect(() => card.syncGrouping());
	$effect(() => card.observe(breakdownBody, breakdownFooter));
</script>

<!-- Breakdown by attribute -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
	class="panel flex min-h-0 flex-col"
	aria-label="{m.overview_dashboard_by()} {attribute?.name ?? ''}"
	onkeydown={card.paging.handleKeydown}
	data-breakdown-ready={card.paging.ready}
>
	<div class="flex min-h-tap shrink-0 items-center justify-between gap-3 lg:min-h-8">
		<h2 class="section-title">{m.overview_dashboard_by()}</h2>
		{#if attribute}
			<Select.Root type="single" bind:value={grouping.groupBy} onValueChange={grouping.change}>
				<Select.Trigger
					size="sm"
					aria-label={attribute.name}
					class="section-title mr-auto -ml-1 h-auto border-0 bg-transparent px-1 py-0 !text-ink shadow-none [&_*]:!text-ink"
					>{attribute?.name}</Select.Trigger
				>
				<Select.Content>
					{#each categories as option (option.id)}
						<Select.Item value={option.id}>{option.name}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}
		{#if attribute}
			<div class="flex shrink-0 items-center gap-1">
				<Select.Root
					type="single"
					value={groupJump.key ?? ''}
					onValueChange={(next) => next && groupJump.jump(next)}
				>
					<Select.Trigger size="sm" aria-label={m.overview_jump_label()} data-group-jump
						>{m.overview_jump_label()}</Select.Trigger
					>
					<Select.Content>
						{#each groups as group (frontierKey(group))}
							<Select.Item value={frontierKey(group)}>{group.value}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
				<GroupComparisonDialog {groups} {matrix} {worksiteTotal} />
			</div>
		{/if}
	</div>
	<div
		class="breakdown-pages relative mt-1.5 flex min-h-0 flex-1 flex-col"
		bind:this={breakdownBody}
	>
		<ul
			class="relative min-h-0 flex-1 overflow-hidden border-t border-rule"
			class:border-b={!card.showFooter}
			class:empty-breakdown={!attribute || groups.length === 0}
			data-breakdown-rows
		>
			{#if !attribute}
				<li class="text-sm text-ink-3">{m.overview_no_grouping_message()}</li>
			{:else if groups.length === 0}
				<li class="text-sm text-ink-3">
					{m.overview_no_values({ attribute: attribute.name })}
				</li>
			{/if}
			{#each groups as group, index (group.answerId)}
				{@const offPage = breakdownPaging.ready && !card.visibleRows.includes(index)}
				<li
					class="breakdown-row flex min-h-[5.5rem] flex-col justify-center border-t border-rule"
					class:off-page={offPage}
					inert={offPage}
					aria-hidden={offPage ? 'true' : undefined}
					data-group-row
				>
					<div class="flex items-baseline gap-2">
						<a
							href={groupHref(group)}
							class="min-w-0 truncate text-base font-semibold text-inherit hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							title={group.value}>{group.value}</a
						>
						<span class="font-mono text-xs text-ink-3 tabular-nums">{group.total}</span>
						<span class="ml-auto text-xl leading-none font-semibold tracking-headline tabular-nums"
							>{pct(group.rate)}</span
						>
					</div>
					<div class="mt-1.5">
						<OverviewSegmentBar counts={group.counts} height="h-2" neutral {theme} {palette} />
					</div>
					<div class="mt-0.5 font-mono text-xs text-ink-3 tabular-nums" data-group-counts>
						<OverviewLevelCounts counts={group.counts} all={false} />
					</div>
					<div class="mt-0.5 font-mono text-xs text-ink-3 tabular-nums">
						{m.overview_group_coverage({
							leaders: group.leaders,
							needed: group.needed,
							group: group.value
						})}
					</div>
				</li>
			{/each}
		</ul>
		<GroupPager
			{...card.range}
			page={breakdownPaging.page}
			pageCount={breakdownPaging.pages.length}
			previousLabel={m.overview_breakdown_previous_label()}
			nextLabel={m.overview_breakdown_next_label()}
			pageLabel={m.overview_breakdown_page_label()}
			onprevious={(button) => breakdownPaging.goTo(breakdownPaging.page - 1, button)}
			onnext={(button) => breakdownPaging.goTo(breakdownPaging.page + 1, button)}
			visible={card.showFooter}
			bind:element={breakdownFooter}
		/>
	</div>
</section>

<style>
	.empty-breakdown {
		min-height: min-content;
		flex: none;
	}
	.breakdown-row.off-page {
		position: absolute;
		inset-inline: 0;
		top: 0;
		visibility: hidden;
	}
	/* Below the fixed dashboard floor, keep the reading's page budget bounded. */
	@media (width < 64rem), (height < 40rem) {
		.breakdown-pages {
			height: 24rem;
			flex: none;
		}
	}
	:global(.dashboard[data-scroll-region]) .breakdown-pages {
		height: 24rem;
		flex: none;
	}
</style>
