<script lang="ts">
	/**
	 * The dropdown that picks one filter value. Used by the Workers table and by
	 * Mapping's view options, which is why it lives here and not in a view.
	 */
	import type { Snippet } from 'svelte';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import SwatchDot from '#lib/shared/swatch-dot.svelte';
	import { assessmentColorFor, isAssessment } from '#lib/shared/assessment.ts';

	type Props = {
		label: string;
		options: readonly string[];
		selected: readonly string[];
		onToggle: (option: string, checked: boolean) => void;
		/**
		 * How many workers hold each option. A function, read when the menu opens, so
		 * the figures are never older than the Workers table the organizer is looking at.
		 */
		counts?: () => Readonly<Record<string, number>>;
		/** An Assessment is named with its colour dot wherever it is listed. */
		assessment?: boolean;
		/** Replaces the default labelled button, e.g. with a column header's icon. */
		trigger?: Snippet<[{ props: Record<string, unknown> }]>;
	};

	let { label, options, selected, onToggle, counts, assessment = false, trigger }: Props = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			{#if trigger}
				{@render trigger({ props })}
			{:else}
				<Button {...props} variant="outline" size="sm" class="min-h-tap lg:min-h-8">
					{label}
					{#if selected.length}
						<Badge variant="secondary" class="num">{selected.length}</Badge>
					{/if}
				</Button>
			{/if}
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start">
		{#if options.length === 0}
			<!--
				A Worksite that has not filled in this category still gets a filter
				button, because the column comes from its own configuration. Opening
				it used to show an empty panel, so say where the values are written.
			-->
			<DropdownMenu.Group>
				<div class="grid gap-0.5 px-2 py-1.5">
					<p class="text-sm text-muted-foreground">Nothing set up yet.</p>
					<p class="text-sm text-muted-foreground">Add {label.toLowerCase()} in Configuration.</p>
				</div>
			</DropdownMenu.Group>
		{:else}
			<DropdownMenu.Group>
				{#each options as option (option)}
					<DropdownMenu.CheckboxItem
						checked={selected.includes(option)}
						onCheckedChange={(checked) => onToggle(option, checked === true)}
						closeOnSelect={false}
					>
						{#if assessment && isAssessment(option)}
							<SwatchDot color={assessmentColorFor(option)} class="mr-2" />
						{/if}
						{option}
						{#if counts}
							<span class="num ml-auto font-mono text-xs text-muted-foreground">
								{counts()[option] ?? 0}
							</span>
						{/if}
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Group>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>
