<script lang="ts">
	/**
	 * One group of the Highlight builder: the sentence "Workers who match all of these" (or any
	 * of these), whose dropdown sets how its conditions combine. Each condition is a clause
	 * row or a nested group. Edits are made on the whole query
	 * (`root`) with the edit helpers, and the new whole query goes up through `onChange`.
	 */
	import XIcon from '@lucide/svelte/icons/x';
	import * as Select from '#lib/components/ui/select/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import MapHighlightClause from './map-highlight-clause.svelte';
	import MapHighlightGroup from './map-highlight-group.svelte';
	import {
		addClause,
		addGroup,
		removeRule,
		setClauseField,
		setClauseOperator,
		setGroupMatch,
		toggleClauseValue
	} from './map-highlight-query-edit.ts';
	import type { HighlightVocabulary } from './map-highlight-query-codec.ts';
	import {
		maxHighlightDepth,
		type HighlightClause,
		type HighlightField,
		type HighlightGroup,
		type HighlightMatch,
		type HighlightOperator
	} from './map-highlight-query.ts';

	type Props = {
		root: HighlightGroup;
		group: HighlightGroup;
		level: number;
		vocabulary: HighlightVocabulary;
		onChange: (next: HighlightGroup) => void;
	};

	let { root, group, level, vocabulary, onChange }: Props = $props();

	const matchItems = $derived([
		{ value: 'all', label: m.mapping_highlight_match_all() },
		{ value: 'any', label: m.mapping_highlight_match_any() }
	]);

	const matchSentence = $derived(
		group.match === 'all'
			? m.mapping_highlight_match_sentence_all()
			: m.mapping_highlight_match_sentence_any()
	);
	const ruleCount = $derived(group.rules.length);
	const conditionWord = $derived(
		ruleCount === 1
			? m.mapping_highlight_conditions_one({ count: ruleCount })
			: m.mapping_highlight_conditions_other({ count: ruleCount })
	);

	function chooseMatch(value: string): void {
		if (value === 'all' || value === 'any') {
			onChange(setGroupMatch(root, group.id, value as HighlightMatch));
		}
	}

	function changeField(clause: HighlightClause, field: HighlightField): void {
		onChange(setClauseField(root, clause.id, field));
	}

	function changeOperator(clause: HighlightClause, operator: HighlightOperator): void {
		onChange(setClauseOperator(root, clause.id, operator));
	}

	function toggleValue(clause: HighlightClause, value: string): void {
		onChange(toggleClauseValue(root, clause.id, value));
	}
</script>

<div
	role="group"
	aria-label="{matchSentence}, {conditionWord}"
	data-testid="highlight-group"
	class="flex flex-col gap-2 {level > 1 ? 'ml-2 border-l border-rule-strong pl-3' : ''}"
>
	<div class="flex flex-wrap items-center gap-2">
		<span aria-hidden="true" class="text-sm text-ink-2">{m.mapping_highlight_match_prefix()}</span>
		<Select.Root type="single" items={matchItems} value={group.match} onValueChange={chooseMatch}>
			<Select.Trigger
				class="min-h-tap md:min-h-9"
				aria-label={matchSentence}
				data-testid="highlight-match"
			>
				<Select.Value />
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					{#each matchItems as item (item.value)}
						<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>

		<span aria-hidden="true" class="text-sm text-ink-2">{m.mapping_highlight_match_suffix()}</span>

		{#if level > 1}
			<Button
				variant="ghost"
				size="icon"
				class="ml-auto min-h-tap md:min-h-9"
				aria-label={m.mapping_highlight_remove_group()}
				data-testid="highlight-remove-group"
				onclick={() => onChange(removeRule(root, group.id))}
			>
				<XIcon />
			</Button>
		{/if}
	</div>

	{#each group.rules as rule (rule.id)}
		{#if rule.type === 'clause'}
			<MapHighlightClause
				clause={rule}
				{vocabulary}
				onField={(field) => changeField(rule, field)}
				onOperator={(operator) => changeOperator(rule, operator)}
				onToggleValue={(value) => toggleValue(rule, value)}
				onRemove={() => onChange(removeRule(root, rule.id))}
			/>
		{:else}
			<MapHighlightGroup {root} group={rule} level={level + 1} {vocabulary} {onChange} />
		{/if}
	{/each}

	<div class="flex flex-wrap items-center gap-2">
		<Button
			variant="outline"
			size="sm"
			class="min-h-tap md:min-h-9"
			data-testid="highlight-add-rule"
			onclick={() => onChange(addClause(root, group.id))}
		>
			{m.mapping_highlight_add_condition()}
		</Button>
		{#if level < maxHighlightDepth}
			<Button
				variant="outline"
				size="sm"
				class="min-h-tap md:min-h-9"
				data-testid="highlight-add-group"
				onclick={() => onChange(addGroup(root, group.id))}
			>
				{m.mapping_highlight_add_group()}
			</Button>
		{/if}
	</div>
</div>
