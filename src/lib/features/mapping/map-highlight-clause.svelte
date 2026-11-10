<script lang="ts">
	/**
	 * One rule row of the Highlight builder: a field, how its values match, the values
	 * themselves, and a remove control. Changes go up through callbacks; the row keeps
	 * no state of its own.
	 */
	import XIcon from '@lucide/svelte/icons/x';
	import * as Select from '#lib/components/ui/select/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import MapAnswerDropdown from './map-answer-dropdown.svelte';
	import {
		highlightFieldKey,
		highlightFieldOptions,
		highlightOperatorOptions,
		highlightValueOptions
	} from './map-highlight-fields.ts';
	import type {
		HighlightClause,
		HighlightField,
		HighlightOperator
	} from './map-highlight-query.ts';
	import type { HighlightVocabulary } from './map-highlight-query-codec.ts';

	type Props = {
		clause: HighlightClause;
		vocabulary: HighlightVocabulary;
		onField: (field: HighlightField) => void;
		onOperator: (operator: HighlightOperator) => void;
		onToggleValue: (value: string) => void;
		onRemove: () => void;
	};

	let { clause, vocabulary, onField, onOperator, onToggleValue, onRemove }: Props = $props();

	const fieldItems = $derived(
		highlightFieldOptions(vocabulary).map((option) => ({ value: option.key, label: option.label }))
	);
	const fieldKeys = $derived(new Set(fieldItems.map((item) => item.value)));
	const currentFieldKey = $derived(highlightFieldKey(clause.field));
	/** A field the vocabulary no longer holds shows nothing selected rather than a raw key. */
	const fieldValue = $derived(fieldKeys.has(currentFieldKey) ? currentFieldKey : '');

	// The labels come from the field's kind; a held 'all' stays offered even when the field cannot offer it.
	const operatorItems = $derived(
		highlightOperatorOptions(clause.field, vocabulary, clause.operator).map((option) => ({
			value: option.value,
			label: option.label
		}))
	);

	const valueOptions = $derived(
		highlightValueOptions(clause.field, vocabulary).map((option) => ({
			id: option.id,
			label: option.label,
			depth: option.depth
		}))
	);

	function chooseField(key: string): void {
		const option = highlightFieldOptions(vocabulary).find((candidate) => candidate.key === key);
		if (option) onField(option.field);
	}

	function chooseOperator(value: string): void {
		if (value === 'any' || value === 'all' || value === 'none') onOperator(value);
	}
</script>

<div class="flex flex-wrap items-center gap-2" data-testid="highlight-rule">
	<div class="min-w-0 flex-1 basis-32">
		<Select.Root type="single" items={fieldItems} value={fieldValue} onValueChange={chooseField}>
			<Select.Trigger
				class="min-h-tap w-full md:min-h-9"
				aria-label={m.mapping_highlight_field()}
				data-testid="highlight-field"
			>
				<Select.Value />
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					{#each fieldItems as item (item.value)}
						<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
	</div>

	<div class="min-w-0 flex-1 basis-32">
		<Select.Root
			type="single"
			items={operatorItems}
			value={clause.operator}
			onValueChange={chooseOperator}
		>
			<Select.Trigger
				class="min-h-tap w-full md:min-h-9"
				aria-label={m.mapping_highlight_operator()}
				data-testid="highlight-operator"
			>
				<Select.Value />
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					{#each operatorItems as item (item.value)}
						<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
	</div>

	<div class="min-w-0 flex-1 basis-32" data-testid="highlight-values">
		<MapAnswerDropdown
			label={m.mapping_highlight_values()}
			options={valueOptions}
			selected={clause.values}
			onToggle={(id) => onToggleValue(id)}
		/>
	</div>

	<Button
		variant="ghost"
		size="icon"
		class="min-h-tap md:min-h-9"
		aria-label={m.mapping_highlight_remove_condition()}
		data-testid="highlight-remove-rule"
		onclick={onRemove}
	>
		<XIcon />
	</Button>
</div>
