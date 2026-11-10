<script lang="ts">
	import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
	import { assessmentGroupLabel, assessmentLabel } from '#lib/i18n/assessment.ts';
	import { assessmentBreakdown } from './overview-readings.ts';

	let {
		counts,
		all
	}: {
		counts: Record<AssessmentOption, number>;
		all: boolean;
	} = $props();
</script>

{#each assessmentBreakdown(counts).filter((row) => all || row.count > 0) as row, i (row.option)}
	{#if i > 0}<span aria-hidden="true"> · </span>{/if}<span
		>{row.count}
		{row.count === 1 ? assessmentLabel(row.option) : assessmentGroupLabel(row.option)}</span
	>
{/each}
