<script lang="ts">
	/**
	 * The Filter disclosure: the button and its Popover. The popover is anchored to the
	 * button and bounded by the canvas, so it never travels across the map.
	 */
	import FunnelIcon from '@lucide/svelte/icons/funnel';
	import type { Language, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
	import { NO_SELECTION_CHOICE } from '#lib/shared/no-value-reading.ts';
	import { m } from '#lib/paraglide/messages.js';
	import MapAnswerDropdown from './map-answer-dropdown.svelte';
	import { includeFilterChoices } from './map-contextual-filters.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import type { MapViewState } from './map-view-state.svelte.ts';

	type Props = {
		view: MapViewState;
		attributes: readonly WorkerAttributeDefinition[];
		languages: readonly Language[];
		attributeById: ReadonlyMap<string, WorkerAttributeDefinition>;
		/** The canvas the popover must stay inside. */
		boundary: HTMLElement | undefined;
		hasFilters: boolean;
		activeFilterNameCount: number;
		onReset: () => void;
		onClearFilters: () => void;
	};

	let {
		view,
		attributes,
		languages,
		attributeById,
		boundary,
		hasFilters,
		activeFilterNameCount,
		onReset,
		onClearFilters
	}: Props = $props();

	const panelButton =
		'min-h-tap border-rule-strong bg-panel hover:bg-hover dark:bg-panel dark:hover:bg-hover md:min-h-9';

	/**
	 * An Attribute's answers, identified by their id and listed by their display
	 * label: a repeated leaf label keeps its path so two branches stay tellable.
	 */
	function answerOptions(attribute: WorkerAttributeDefinition): { id: string; label: string }[] {
		return attribute.answers.map((answer) => ({
			id: answer.id,
			label: answerDisplayLabel(attribute.answers, answer.id)
		}));
	}
	function isValueHidden(attributeId: string, answerId: string): boolean {
		return (view.hiddenValues[attributeId] ?? []).includes(answerId);
	}
	function shownValues(attributeId: string): string[] {
		const attribute = attributeById.get(attributeId);
		if (!attribute) return [];
		return answerOptions(attribute)
			.map((option) => option.id)
			.filter((answerId) => !isValueHidden(attributeId, answerId));
	}
	function toggleValueVisible(attributeId: string, answerId: string, checked: boolean) {
		if (isValueHidden(attributeId, answerId) !== !checked) {
			view.toggleValue(attributeId, answerId);
		}
	}

	const languageOptions = $derived(languages.map(({ id, name }) => ({ id, label: name })));
	const shownLanguages = $derived(
		languageOptions.map(({ id }) => id).filter((id) => !view.hiddenLanguages.includes(id))
	);

	/**
	 * The Include choices active for one Attribute: its answers, plus the shared
	 * no-answer key when its no-value reading is chosen. Both kinds are conditions on
	 * the displayed population, exactly like the same `f`/`missing` link entries.
	 */
	function includedChoices(attribute: WorkerAttributeDefinition): string[] {
		const answers = view.contextFilters.answers[attribute.id] ?? [];
		return view.contextFilters.missing.includes(attribute.id)
			? [...answers, NO_SELECTION_CHOICE]
			: answers;
	}

	function toggleIncluded(attributeId: string, choice: string, checked: boolean) {
		if (choice === NO_SELECTION_CHOICE) view.toggleContextMissing(attributeId, checked);
		else view.toggleContextAnswer(attributeId, choice, checked);
	}

	/** The panel's width (`w-72`) in rem, which decides which edge of the button it hangs from. */
	const panelRem = 18;

	let filterOpen = $state(false);
	let trigger: HTMLElement | null = $state(null);
	let align: 'start' | 'end' = $state('start');

	/** Hangs from the button's start; if that would run off the canvas's right edge, from its end. */
	function chooseAlign(open: boolean) {
		if (!open || !trigger || !boundary) return;
		const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
		const runsOff =
			trigger.getBoundingClientRect().left + panelRem * rootFontSize >
			boundary.getBoundingClientRect().right;
		align = runsOff ? 'end' : 'start';
	}
</script>

<Popover.Root bind:open={filterOpen} onOpenChange={chooseAlign}>
	<Popover.Trigger bind:ref={trigger}>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				size="sm"
				data-material="glass"
				class="pointer-events-auto min-h-tap border-rule-strong md:min-h-9"
			>
				<FunnelIcon />
				{m.mapping_filter()}
				{#if activeFilterNameCount > 0}
					<!-- The documented filter count: the inset/secondary stop, not the action fill. -->
					<span
						class="num inline-flex items-center rounded-full bg-secondary px-1.5 py-px text-2xs leading-tight font-medium text-secondary-foreground"
					>
						{activeFilterNameCount}
					</span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		id="map-filter-panel"
		{align}
		sideOffset={4}
		collisionBoundary={boundary}
		class="max-h-(--bits-popover-content-available-height) w-72 max-w-full gap-0 overflow-y-auto rounded-surface bg-panel p-3 shadow-[var(--surface-shadow)]"
	>
		<div class="flex flex-wrap gap-2">
			{#each attributes as attribute (attribute.id)}
				<MapAnswerDropdown
					label={attribute.name}
					options={answerOptions(attribute)}
					selected={shownValues(attribute.id)}
					onToggle={(answerId, checked) => toggleValueVisible(attribute.id, answerId, checked)}
				/>
			{/each}
			<MapAnswerDropdown
				label={m.domain_language()}
				options={languageOptions}
				selected={shownLanguages}
				onToggle={(languageId, checked) => {
					if (view.hiddenLanguages.includes(languageId) !== !checked)
						view.toggleLanguage(languageId);
				}}
			/>
		</div>
		{#if attributes.length > 0}
			<fieldset class="mt-3 grid gap-2 border-t border-rule pt-3" data-testid="map-include-filters">
				<legend class="text-sm font-medium">{m.mapping_include_heading()}</legend>
				<div class="flex flex-wrap gap-2">
					{#each attributes as attribute (attribute.id)}
						<MapAnswerDropdown
							label={attribute.name}
							ariaLabel={m.mapping_include_attribute({ attribute: attribute.name })}
							options={includeFilterChoices(attribute)}
							selected={includedChoices(attribute)}
							onToggle={(choice, checked) => toggleIncluded(attribute.id, choice, checked)}
						/>
					{/each}
				</div>
			</fieldset>
		{/if}
		<div class="mt-3 flex gap-2">
			<Button
				variant="outline"
				size="sm"
				class={panelButton}
				disabled={!hasFilters}
				onclick={onClearFilters}
			>
				{m.mapping_clear_filters()}
			</Button>
			<Button variant="outline" size="sm" class={panelButton} onclick={onReset}
				>{m.mapping_reset_all()}</Button
			>
		</div>
	</Popover.Content>
</Popover.Root>
