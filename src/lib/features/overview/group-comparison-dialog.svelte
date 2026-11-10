<script lang="ts">
	/**
	 * Two groups of the selected Attribute, side by side. Every figure names the
	 * population it divides by; a narrow dialog stacks the two groups per quantity.
	 */
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Dialog from '#lib/components/ui/dialog/index.ts';
	import * as Select from '#lib/components/ui/select/index.ts';
	import { assessmentGroupLabel } from '#lib/i18n/assessment.ts';
	import { m } from '#lib/paraglide/messages.js';
	import {
		compareGroups,
		frontierKey,
		type Figure,
		type GroupColumn
	} from './overview-comparison.ts';
	import type { AgitationMatrixRow, GroupReading } from './support-summary.ts';

	let {
		groups,
		matrix,
		worksiteTotal
	}: {
		groups: GroupReading[];
		matrix: { columns: { id: string; text: string; count: number }[]; rows: AgitationMatrixRow[] };
		worksiteTotal: number;
	} = $props();

	let first = $state('');
	let second = $state('');
	const comparison = $derived(
		first && second ? compareGroups({ groups, matrix, worksiteTotal }, first, second) : null
	);

	const label = (key: string) => groups.find((g) => frontierKey(g) === key)?.value ?? '';
	const population = (f: Figure) =>
		f.population.kind === 'worksite'
			? m.overview_population_worksite()
			: m.overview_population_group({ group: f.population.name });
	const text = (f: Figure) =>
		f.share === null
			? m.overview_compare_figure_none({ count: f.count })
			: m.overview_compare_figure({
					count: f.count,
					of: f.of,
					percent: Math.round(f.share * 100) + '%'
				});
</script>

{#snippet cell(column: GroupColumn, f: Figure)}
	<div class="min-w-0" data-compare-cell>
		<span class="block text-xs text-ink-3 sm:hidden">{column.label}</span>
		<span class="font-mono text-sm tabular-nums">{text(f)}</span>
		<span class="block text-xs text-ink-3">{population(f)}</span>
	</div>
{/snippet}

{#snippet rowOf(title: string, pick: (column: GroupColumn) => Figure | undefined, rowKey?: string)}
	<div
		class="grid gap-x-4 gap-y-2 border-t border-rule py-2 sm:grid-cols-[10rem_1fr_1fr]"
		data-compare-row={rowKey ?? title}
	>
		<div class="text-sm font-medium">{title}</div>
		{#if comparison}
			{#each comparison.columns as column (column.key)}
				{@const f = pick(column)}
				{#if f}{@render cell(column, f)}{/if}
			{/each}
		{/if}
	</div>
{/snippet}

<Dialog.Root>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" disabled={groups.length < 2}
				>{m.overview_compare_open()}</Button
			>
		{/snippet}
	</Dialog.Trigger>
	<Dialog.Content class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" data-group-comparison>
		<Dialog.Header>
			<Dialog.Title>{m.overview_compare_title()}</Dialog.Title>
		</Dialog.Header>
		<div class="grid gap-2 sm:grid-cols-2">
			{#each [{ name: 'first', title: m.overview_compare_first() }, { name: 'second', title: m.overview_compare_second() }] as slot (slot.name)}
				{@const value = slot.name === 'first' ? first : second}
				<Select.Root
					type="single"
					{value}
					onValueChange={(next) => (slot.name === 'first' ? (first = next) : (second = next))}
				>
					<Select.Trigger aria-label={slot.title} class="w-full" data-compare-pick={slot.name}
						>{label(value) || slot.title}</Select.Trigger
					>
					<Select.Content>
						{#each groups as group (frontierKey(group))}
							<Select.Item
								value={frontierKey(group)}
								disabled={frontierKey(group) === (slot.name === 'first' ? second : first)}
								>{group.value}</Select.Item
							>
						{/each}
					</Select.Content>
				</Select.Root>
			{/each}
		</div>
		{#if !comparison}
			<p class="text-sm text-ink-3">{m.overview_compare_choose()}</p>
		{:else}
			<div class="hidden grid-cols-[10rem_1fr_1fr] gap-x-4 sm:grid" aria-hidden="true">
				<span></span>
				{#each comparison.columns as column (column.key)}
					<span class="min-w-0 truncate text-sm font-semibold">{column.label}</span>
				{/each}
			</div>
			<div data-compare-table>
				{@render rowOf(m.overview_compare_workers(), (c) => c.workers, 'workers')}
				{@render rowOf(m.overview_compare_support(), (c) => c.support, 'support')}
				{@render rowOf(m.overview_compare_assessed(), (c) => c.assessed, 'assessed')}
				<div
					class="grid gap-x-4 gap-y-2 border-t border-rule py-2 sm:grid-cols-[10rem_1fr_1fr]"
					data-compare-row="leaders"
				>
					<div class="text-sm font-medium">{m.domain_committee_coverage()}</div>
					{#each comparison.columns as column (column.key)}
						<div class="min-w-0">
							<span class="block text-xs text-ink-3 sm:hidden">{column.label}</span>
							<span class="font-mono text-sm tabular-nums"
								>{m.overview_coverage_units(column.leaders)}</span
							>
							<span class="block text-xs text-ink-3"
								>{m.overview_population_group({ group: column.label })}</span
							>
						</div>
					{/each}
				</div>
				{#each comparison.columns[0].levels as level, i (level.option)}
					{@render rowOf(
						assessmentGroupLabel(level.option),
						(c) => c.levels[i].figure,
						`level-${level.option}`
					)}
				{/each}
				{#each comparison.agitations as agitation, i (agitation.id)}
					{@render rowOf(agitation.text, (c) => c.agitations[i], `agitation-${agitation.id}`)}
				{:else}
					<div class="border-t border-rule py-2 text-sm text-ink-3" data-compare-row="agitations">
						{m.overview_tab_agitations()}: {m.overview_compare_no_agitations()}
					</div>
				{/each}
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
