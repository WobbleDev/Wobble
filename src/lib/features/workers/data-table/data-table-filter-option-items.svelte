<script lang="ts">
	/**
	 * The checkbox rows of one filter's options, shared by the column header menu and
	 * the toolbar Filters menu so the two never diverge. Each row keeps the menu open
	 * while the reader ticks several options.
	 */
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import SwatchDot from '#lib/shared/swatch-dot.svelte';
	import { assessmentColorFor, isAssessment } from '#lib/shared/assessment.ts';
	import { workerCount } from '../copy.ts';
	import type { OptionChoice } from '../answers.ts';

	type Props = {
		options: readonly OptionChoice[];
		/** The values chosen. */
		selected: readonly string[];
		onToggle: (value: string, checked: boolean) => void;
		/** How many Workers hold each value, read when the menu opens. */
		counts?: () => Readonly<Record<string, number>>;
		/** An Assessment is named with its colour dot wherever it is listed. */
		assessment?: boolean;
	};

	let { options, selected, onToggle, counts, assessment = false }: Props = $props();

	/** The row's accessible name: its reading, its collision description and its count. */
	function optionLabel(option: OptionChoice, count: number | undefined): string {
		const reading = option.description ? `${option.label} (${option.description})` : option.label;
		return count === undefined ? reading : `${reading}, ${workerCount(count)}`;
	}
</script>

{#each options as option (option.value)}
	{@const count = counts ? (counts()[option.value] ?? 0) : undefined}
	{@const standing = option.value}
	<DropdownMenu.CheckboxItem
		checked={selected.includes(option.value)}
		onCheckedChange={(checked) => onToggle(option.value, checked === true)}
		closeOnSelect={false}
		data-missing={option.missing ? 'true' : undefined}
		aria-label={optionLabel(option, count)}
	>
		{#if assessment && isAssessment(standing)}
			<SwatchDot color={assessmentColorFor(standing)} class="mr-2" />
		{/if}
		<span class="flex min-w-0 flex-col">
			<span>{option.label}</span>
			{#if option.description}
				<span class="text-xs font-normal text-muted-foreground">
					{option.description}
				</span>
			{/if}
		</span>
		{#if counts}
			<span class="num ml-auto font-mono text-xs text-muted-foreground">
				{counts()[option.value] ?? 0}
			</span>
		{/if}
	</DropdownMenu.CheckboxItem>
{/each}
