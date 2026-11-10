<script lang="ts">
	/**
	 * The map's toolbar: the filter, grouping and zoom controls that change what
	 * the canvas draws.
	 */
	import SearchIcon from '@lucide/svelte/icons/search';
	import ZoomInIcon from '@lucide/svelte/icons/zoom-in';
	import ZoomOutIcon from '@lucide/svelte/icons/zoom-out';
	import MaximizeIcon from '@lucide/svelte/icons/maximize';
	import HighlighterIcon from '@lucide/svelte/icons/highlighter';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import XIcon from '@lucide/svelte/icons/x';
	import * as Select from '#lib/components/ui/select/index.ts';
	import IconTip from '#lib/shared/icon-tip.svelte';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { Language, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { hasContextualFilters } from '#lib/shared/contextual-filters.ts';
	import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
	import { noValueReading } from '#lib/shared/no-value-reading.ts';
	import {
		regionReading,
		type ExpansionBranch,
		type ExpansionRefusal,
		type GroupingReading,
		type SubGroupingReading
	} from './map-grouping.ts';
	import {
		contextFilterChips,
		contextFilterGroupCount,
		type ContextFilterChip
	} from './map-contextual-filters.ts';
	import MapFilterPanel from './map-filter-panel.svelte';
	import MapHighlightGroup from './map-highlight-group.svelte';
	import { starterQuery, withStarterRule } from './map-highlight-query-edit.ts';
	import { describeHighlightQuery } from './map-highlight-fields.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Separator } from '#lib/components/ui/separator/index.ts';
	import type { PanZoom } from './map-pan-zoom.svelte.ts';
	import type { MapViewState } from './map-view-state.svelte.ts';
	import type { SearchResult } from './map-search-results.ts';
	import { assessmentLabel } from '#lib/i18n/assessment.ts';
	import SavedViewsMenu from '#lib/features/saved-views/saved-views-menu.svelte';
	import type { SavedViews } from '#lib/features/saved-views/saved-views.svelte.ts';

	type Props = {
		panZoom: PanZoom;
		query: string;
		matchCount: number;
		/** The Workers the search names, each marked drawn or hidden by the current view. */
		results: readonly SearchResult[];
		/** A drawn result: select it on the map and move focus to it. */
		onChooseResult: (workerId: string) => void;
		/** A hidden result: open it in Workers without changing the map's conditions. */
		onOpenResultInWorkers: (workerId: string) => void;
		view: MapViewState;
		savedViews: SavedViews;
		attributes: readonly WorkerAttributeDefinition[];
		languages: readonly Language[];
		/** The Workers the complete Highlight query selects, of those drawn; undefined with no complete rule. */
		highlightCount: { matching: number; drawn: number } | undefined;
		/** Availability for every Grouping choice, read from the one ledger. */
		groupingReadings: ReadonlyMap<string, GroupingReading>;
		/**
		 * Whether each secondary choice puts every displayed Worker in one pair.
		 * Undefined means the primary's own refusal explains the fallback, so the choice is
		 * not marked unavailable on the secondary's account.
		 */
		subGroupingReadings: ReadonlyMap<string, SubGroupingReading | undefined>;
		/** The chosen Grouping's reading, with narrowing guidance. */
		activeGroupingReading: GroupingReading | undefined;
		workerNames: ReadonlyMap<string, string>;
		/** The branches the primary Grouping can open or close, in configured order. */
		expansionBranches: readonly ExpansionBranch[];
		/** The refused primary expansion, or null while none was attempted. */
		expansionRefusal: ExpansionRefusal | null;
		/** The same detail for the paired Sub-grouping's Attribute. */
		subExpansionBranches: readonly ExpansionBranch[];
		subExpansionRefusal: ExpansionRefusal | null;
		onToggleExpansion: (answerId: string, expand: boolean) => void;
		onToggleSubExpansion: (answerId: string, expand: boolean) => void;
		onClearGrouping: () => void;
		undo: { label: string } | null;
		onUndo: () => void;
		onDismissUndo: () => void;
		onPauseUndo: () => void;
		onResumeUndo: () => void;
		onReset: () => void;
		/**
		 * Recovers the view: the canvas owns where the dots are drawn, so it does the
		 * centring the reset control asks for.
		 */
		onResetFrame: () => void;
		onClearFilters: () => void;
		/** The canvas the Filter popover stays inside. */
		boundary: HTMLElement | undefined;
		/** The floating strip's measured height, for the worker card to dock below. */
		stripHeight?: number;
	};

	let {
		panZoom,
		query = $bindable(),
		matchCount,
		results,
		onChooseResult,
		onOpenResultInWorkers,
		view,
		savedViews,
		attributes,
		languages,
		highlightCount,
		groupingReadings,
		subGroupingReadings,
		activeGroupingReading,
		workerNames,
		expansionBranches,
		expansionRefusal,
		subExpansionBranches,
		subExpansionRefusal,
		onToggleExpansion,
		onToggleSubExpansion,
		onClearGrouping,
		undo,
		onUndo,
		onDismissUndo,
		onPauseUndo,
		onResumeUndo,
		onReset,
		onResetFrame,
		onClearFilters,
		boundary,
		stripHeight = $bindable(0)
	}: Props = $props();

	const noneValue = '__none__';

	/** The result list shows while the search has text and the organizer has not chosen or dismissed it. */
	let resultsOpen = $state(true);
	let resultsElement = $state<HTMLElement>();
	let searchElement = $state<HTMLInputElement | null>(null);

	function resultButtons(): HTMLElement[] {
		return [...(resultsElement?.querySelectorAll<HTMLElement>('[data-search-result]') ?? [])];
	}

	function searchKey(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' && resultsOpen && results.length > 0) {
			event.preventDefault();
			resultButtons()[0]?.focus();
		} else if (event.key === 'Escape' && query && resultsOpen) {
			event.preventDefault();
			resultsOpen = false;
		}
	}

	function resultKey(event: KeyboardEvent) {
		const items = resultButtons();
		const at = items.indexOf(event.target as HTMLElement);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			items[Math.min(at + 1, items.length - 1)]?.focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			if (at <= 0) searchElement?.focus();
			else items[at - 1]?.focus();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			searchElement?.focus();
		}
	}

	function choose(result: SearchResult) {
		resultsOpen = false;
		if (result.hidden) onOpenResultInWorkers(result.id);
		else onChooseResult(result.id);
	}

	/**
	 * The chip's visible remove control stays 28px; on a coarse pointer the 44px touch
	 * floor around it answers instead, without growing the chip.
	 */
	const chipRemoveHitArea =
		"relative coarse:after:absolute coarse:after:top-1/2 coarse:after:left-1/2 coarse:after:size-tap coarse:after:-translate-x-1/2 coarse:after:-translate-y-1/2 coarse:after:content-['']";

	/** Whether the current ledger would let this choice place every displayed Worker. */
	function isGroupingAvailable(attributeId: string): boolean {
		return groupingReadings.get(attributeId)?.status === 'available';
	}

	const groupItems = $derived([
		{ value: noneValue, label: m.common_none() },
		...view.groupableAttributes
			.filter((attribute) => isGroupingAvailable(attribute.id) || attribute.id === view.groupBy)
			.map((attribute) => ({
				value: attribute.id,
				label: isGroupingAvailable(attribute.id)
					? attribute.name
					: m.mapping_group_option_unavailable({ attribute: attribute.name })
			}))
	]);
	const groupSelection = $derived(view.groupBy === '' ? noneValue : view.groupBy);
	/** Whether the attempted pair could place every displayed Worker in one sub-group. */
	function isSubGroupingAvailable(attributeId: string): boolean {
		const reading = subGroupingReadings.get(attributeId);
		return reading === undefined || reading.status === 'available';
	}

	const subGroupItems = $derived([
		{ value: noneValue, label: m.common_none() },
		...view.subGroupingAttributes
			.filter(
				(attribute) => isSubGroupingAvailable(attribute.id) || attribute.id === view.subGroupBy
			)
			.map((attribute) => ({
				value: attribute.id,
				label: isSubGroupingAvailable(attribute.id)
					? attribute.name
					: m.mapping_group_option_unavailable({ attribute: attribute.name })
			}))
	]);
	const subGroupSelection = $derived(view.subGroupBy === '' ? noneValue : view.subGroupBy);

	const groupLabelOf = (items: { value: string; label: string }[], selection: string) =>
		items.find((item) => item.value === selection)?.label ?? '';
	const groupButtonLabel = $derived.by(() => {
		if (view.groupBy === '') return m.mapping_group_button();
		const group = groupLabelOf(groupItems, groupSelection);
		if (view.subGroupBy === '') return m.mapping_group_selected({ group });
		return m.mapping_group_selected_sub({
			group,
			subGroup: groupLabelOf(subGroupItems, subGroupSelection)
		});
	});

	const attributeById = $derived(new Map(attributes.map((attribute) => [attribute.id, attribute])));

	/** The chosen Grouping's refusal, when it has one; the status explains it. */
	const groupingRefusal = $derived(
		activeGroupingReading?.status === 'unavailable' ? activeGroupingReading : undefined
	);
	const groupingAttribute = $derived(view.groupingAttribute);

	/** The refusal in words: which Workers hold more than one region, or which ids are gone. */
	const groupingReason = $derived.by(() => {
		const reading = groupingRefusal;
		const attribute = groupingAttribute;
		if (!reading || !attribute) return '';
		if (reading.reason.code === 'multiple-regions') {
			const workers = reading.reason.workers
				.map(
					({ workerId, keys }) =>
						`${workerNames.get(workerId) ?? workerId} (${keys
							.map((key) => regionReading(attribute, key).label)
							.join(', ')})`
				)
				.join('; ');
			return m.mapping_group_reason_multiple_regions({ attribute: attribute.name, workers });
		}
		// The active reading never carries an expansion refusal; the control explains a
		// refused attempt through the same words if it ever did.
		if (reading.reason.code === 'expansion-breaks-partition') {
			return expansionRefusalText(reading.reason, attribute);
		}
		return m.mapping_group_reason_unresolved({
			attribute: attribute.name,
			answers: reading.reason.answerIds.join(', ')
		});
	});

	/** The checked narrowing filters offered beside the refusal. */
	const groupingSuggestions = $derived.by(() => {
		const reading = groupingRefusal;
		if (!reading) return [];
		return reading.suggestions.flatMap((suggestion) => {
			const attribute = attributeById.get(suggestion.attributeId);
			if (!attribute) return [];
			const answer = suggestion.missing
				? noValueReading(attribute).label
				: answerDisplayLabel(attribute.answers, suggestion.answerIds[0] ?? '');
			return [
				{
					key: `${suggestion.attributeId}:${suggestion.missing ? 'missing' : suggestion.answerIds[0]}`,
					label: m.mapping_group_suggestion({ attribute: attribute.name, answers: answer })
				}
			];
		});
	});

	/** The chosen Sub-grouping's refusal, when the primary stays grouped but pairing cannot. */
	const subGroupingRefusal = $derived(
		activeGroupingReading?.status === 'available' &&
			activeGroupingReading.subGrouping?.status === 'unavailable'
			? activeGroupingReading.subGrouping
			: undefined
	);
	const subGroupingAttribute = $derived(view.subGroupingAttribute);

	/** The pairing refusal in words: each Worker's pairs, read by both questions. */
	const subGroupingReason = $derived.by(() => {
		const reading = subGroupingRefusal;
		const primary = groupingAttribute;
		const secondary = subGroupingAttribute;
		if (!reading || !primary || !secondary) return '';
		if (reading.reason.code === 'paired-regions-differ') {
			const workers = reading.reason.workers
				.map(({ workerId, pairs }) => {
					const pairText = pairs
						.map(
							([group, subGroup]) =>
								`${regionReading(primary, group).label} / ${
									regionReading(secondary, subGroup).label
								}`
						)
						.join(', ');
					return `${workerNames.get(workerId) ?? workerId} (${pairText})`;
				})
				.join('; ');
			return m.mapping_sub_group_reason_paired_regions({
				subAttribute: secondary.name,
				workers
			});
		}
		return m.mapping_group_reason_unresolved({
			attribute: secondary.name,
			answers: reading.reason.answerIds.join(', ')
		});
	});

	/** The checked narrowing filters offered beside a pairing refusal. */
	const subGroupingSuggestions = $derived.by(() => {
		const reading = subGroupingRefusal;
		if (!reading) return [];
		return reading.suggestions.flatMap((suggestion) => {
			const attribute = attributeById.get(suggestion.attributeId);
			if (!attribute) return [];
			const answer = suggestion.missing
				? noValueReading(attribute).label
				: answerDisplayLabel(attribute.answers, suggestion.answerIds[0] ?? '');
			return [
				{
					key: `sub:${suggestion.attributeId}:${suggestion.missing ? 'missing' : suggestion.answerIds[0]}`,
					label: m.mapping_group_suggestion({ attribute: attribute.name, answers: answer })
				}
			];
		});
	});

	/** A refused branch expansion in words: the Workers it would split across regions. */
	function expansionRefusalText(
		reading: ExpansionRefusal | null,
		attribute: WorkerAttributeDefinition | undefined
	): string {
		if (!reading || !attribute) return '';
		const workers = reading.workers
			.map(
				({ workerId, keys }) =>
					`${workerNames.get(workerId) ?? workerId} (${keys
						.map((key) => regionReading(attribute, key).label)
						.join(', ')})`
			)
			.join('; ');
		return m.mapping_expansion_refused({
			answer: regionReading(attribute, reading.branchId).label,
			workers
		});
	}

	const expansionRefusalReason = $derived(
		expansionRefusalText(expansionRefusal, groupingAttribute)
	);
	const subExpansionRefusalReason = $derived(
		expansionRefusalText(subExpansionRefusal, subGroupingAttribute)
	);

	const hasFilters = $derived(
		view.hiddenAssessments.length > 0 ||
			Object.values(view.hiddenValues).some((values) => values.length > 0) ||
			view.hiddenLanguages.length > 0 ||
			hasContextualFilters(view.contextFilters)
	);
	const activeFilterNameCount = $derived(
		Object.values(view.hiddenValues).filter((values) => values.length > 0).length +
			(view.hiddenLanguages.length > 0 ? 1 : 0) +
			contextFilterGroupCount(view.contextFilters, attributes)
	);
	const chips = $derived(
		Object.entries(view.hiddenValues).flatMap(([attributeId, answerIds]) => {
			const attribute = attributeById.get(attributeId);
			return answerIds.map((answerId) => ({
				attributeId,
				value: answerId,
				label: attribute ? answerDisplayLabel(attribute.answers, answerId) : answerId,
				name: attribute?.name ?? attributeId
			}));
		})
	);
	const languageChips = $derived(
		view.hiddenLanguages.map((id) => ({
			id,
			name: languages.find((language) => language.id === id)?.name ?? id
		}))
	);
	/** The active contextual conditions, named by the current vocabulary. */
	const contextChips = $derived(contextFilterChips(view.contextFilters, attributes));

	/** Removes one contextual condition, keeping every other filter as it was. */
	function removeContextChip(chip: ContextFilterChip) {
		if (chip.missing) view.removeContextMissing(chip.attributeId);
		else view.removeContextAnswer(chip.attributeId, chip.value);
	}

	/** The plain-language summary of the complete Highlight rules; '' while there are none. */
	const highlightSummary = $derived(
		describeHighlightQuery(view.highlight, view.highlightVocabulary)
	);

	/** The mounted, polite live region's text: the Highlight's count, once a query is complete. */
	const highlightAnnouncement = $derived(
		highlightSummary !== '' && highlightCount
			? m.mapping_highlight_count({
					matching: highlightCount.matching,
					drawn: highlightCount.drawn
				})
			: ''
	);
</script>

{#snippet expansionRows(
	branches: readonly ExpansionBranch[],
	toggle: (answerId: string, expand: boolean) => void,
	testId: string
)}
	<div class="flex flex-col gap-1" data-testid={testId}>
		<p class="field-label px-1">{m.mapping_expansion_heading()}</p>
		<ul class="flex flex-col gap-0.5">
			{#each branches as branch (branch.answerId)}
				<li class="flex min-h-tap items-center gap-1 md:min-h-8">
					<button
						type="button"
						data-expand-branch={branch.answerId}
						aria-expanded={branch.expanded}
						aria-label={branch.expanded
							? m.mapping_collapse_branch({ answer: branch.label })
							: m.mapping_expand_branch({ answer: branch.label })}
						onclick={() => toggle(branch.answerId, !branch.expanded)}
						class="flex size-tap shrink-0 items-center justify-center rounded-item p-0 text-ink-2 hover:bg-hover hover:text-ink md:size-7"
					>
						<ChevronDownIcon
							class="size-3.5 transition-transform {branch.expanded ? '' : '-rotate-90'}"
						/>
					</button>
					<span class="min-w-0 flex-1 text-sm break-words text-ink">{branch.label}</span>
				</li>
			{/each}
		</ul>
	</div>
{/snippet}

<!-- In-flow reserved strip below the Shell tier, floating overlay above it: on a
     phone the search, zoom and layout controls take their own row instead of
     covering the small drawing area. -->
<div
	data-testid="mapping-control-strip"
	class="order-1 flex flex-wrap items-start justify-between gap-2 p-3 lg:pointer-events-none lg:absolute lg:inset-x-0 lg:top-0 lg:z-10"
	bind:offsetHeight={stripHeight}
>
	<div class="pointer-events-auto relative">
		<SearchIcon
			class="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-ink-3"
		/>
		<Input
			bind:value={query}
			bind:ref={searchElement}
			oninput={() => (resultsOpen = true)}
			onkeydown={searchKey}
			type="search"
			data-map-worker-search
			placeholder={m.mapping_find_worker()}
			aria-label={m.mapping_find_worker()}
			class="min-h-tap w-44 pl-8 sm:w-56 lg:min-h-9"
			data-material="glass"
		/>
		{#if query}
			<div
				class="absolute top-full left-0 z-20 mt-1 flex w-max max-w-[calc(100vw-1.5rem)] flex-col gap-1"
			>
				<p data-material="glass" class="label num w-max rounded-item px-2 py-1" role="status">
					{matchCount === 0
						? m.mapping_no_matches()
						: matchCount === 1
							? m.mapping_match_one({ count: matchCount })
							: m.mapping_match_other({ count: matchCount })}
				</p>
				{#if resultsOpen && results.length > 0}
					<ul
						bind:this={resultsElement}
						data-testid="map-search-results"
						data-material="glass"
						aria-label={m.mapping_results_label()}
						class="flex max-h-72 w-72 max-w-full flex-col overflow-y-auto rounded-item p-1"
					>
						{#each results as result (result.id)}
							<li>
								<button
									type="button"
									data-search-result={result.id}
									data-hidden={result.hidden ? 'true' : undefined}
									aria-label={result.hidden
										? m.mapping_result_aria_hidden({
												name: result.name,
												detail: [assessmentLabel(result.assessment), result.detail]
													.filter(Boolean)
													.join(', ')
											})
										: m.mapping_result_aria_drawn({
												name: result.name,
												detail: [assessmentLabel(result.assessment), result.detail]
													.filter(Boolean)
													.join(', ')
											})}
									onkeydown={resultKey}
									onclick={() => choose(result)}
									class="flex min-h-tap w-full flex-col items-start rounded-item px-2 py-1 text-left hover:bg-hover focus-visible:bg-hover md:min-h-9"
								>
									<span class="text-sm break-words text-ink">{result.name}</span>
									<span class="label text-ink-3">
										{[assessmentLabel(result.assessment), result.detail]
											.filter(Boolean)
											.join(' · ')} · {result.hidden
											? m.mapping_result_hidden()
											: m.mapping_result_drawn()}
									</span>
									{#if result.hidden}
										<span class="label text-ink-2 underline">{m.mapping_open_in_workers()}</span>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
		{#if highlightAnnouncement !== ''}
			<p
				data-testid="highlight-key"
				aria-hidden="true"
				class={[
					'label num pointer-events-none absolute left-0 w-max px-2 text-ink-3',
					query ? 'top-[calc(100%+2.25rem)]' : 'top-[calc(100%+0.25rem)]'
				]}
			>
				{highlightAnnouncement}
			</p>
		{/if}
		<!-- Mounted outside the condition, so a completed Highlight announces its count. -->
		<p class="sr-only" aria-live="polite">{highlightAnnouncement}</p>
	</div>

	<!-- One row that never grows: the chips scroll sideways instead of wrapping, so the
	     strip keeps its height and the drawing below does not shift as filters come and go. -->
	<div
		data-testid="mapping-chip-row"
		class="pointer-events-auto -my-1 flex min-w-0 basis-full [scrollbar-width:thin] items-center gap-2 overflow-x-auto py-1 lg:flex-1 lg:basis-0 [&>*]:shrink-0"
	>
		{#each chips as chip (`${chip.attributeId}:${chip.value}`)}
			<span
				data-material="glass"
				class="pointer-events-auto inline-flex min-h-tap items-center gap-1 rounded-full pr-1 pl-3 text-sm md:min-h-9"
			>
				{m.mapping_hiding({ label: chip.label })}
				<Button
					variant="ghost"
					size="icon-sm"
					class={`size-7 rounded-full p-0 hover:bg-hover ${chipRemoveHitArea}`}
					aria-label={m.mapping_show_workers_again({ label: chip.label })}
					onclick={() => view.toggleValue(chip.attributeId, chip.value)}
				>
					<XIcon />
				</Button>
			</span>
		{/each}

		{#each languageChips as chip (chip.id)}
			<span
				data-material="glass"
				class="pointer-events-auto inline-flex min-h-tap items-center gap-1 rounded-full pr-1 pl-3 text-sm md:min-h-9"
			>
				{m.mapping_hiding_language({ language: chip.name })}
				<Button
					variant="ghost"
					size="icon-sm"
					class={`size-7 rounded-full p-0 hover:bg-hover ${chipRemoveHitArea}`}
					aria-label={m.mapping_show_language_speakers_again({ language: chip.name })}
					onclick={() => view.toggleLanguage(chip.id)}
				>
					<XIcon />
				</Button>
			</span>
		{/each}

		{#each contextChips as chip (chip.key)}
			<span
				data-testid="context-filter-chip"
				data-attribute-id={chip.attributeId}
				data-value={chip.value}
				data-missing={chip.missing ? 'true' : undefined}
				data-material="glass"
				class="pointer-events-auto inline-flex min-h-tap items-center gap-1 rounded-full pr-1 pl-3 text-sm md:min-h-9"
			>
				{#if chip.attribute}<span class="text-ink-3">{chip.attribute}:</span>{/if}
				{chip.label}
				{#if chip.description}
					<span class="text-ink-3">({chip.description})</span>
				{/if}
				<Button
					variant="ghost"
					size="icon-sm"
					class={`size-7 rounded-full p-0 hover:bg-hover ${chipRemoveHitArea}`}
					aria-label={m.mapping_stop_filtering({ label: chip.label })}
					onclick={() => removeContextChip(chip)}
				>
					<XIcon />
				</Button>
			</span>
		{/each}

		{#if undo}
			<div
				data-material="glass"
				class="pointer-events-auto flex items-center gap-2 rounded-item px-3 py-1"
			>
				<p class="label num text-ink-3" role="status" aria-live="polite">{undo.label}</p>
				<Button
					variant="outline"
					size="sm"
					class="min-h-tap md:min-h-9"
					onclick={onUndo}
					onmouseenter={onPauseUndo}
					onmouseleave={onResumeUndo}
					onfocus={onPauseUndo}
					onblur={onResumeUndo}
				>
					{m.common_undo()}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					class="min-h-tap md:min-h-9"
					onclick={onDismissUndo}
					aria-label={m.mapping_dismiss_report()}
					onmouseenter={onPauseUndo}
					onmouseleave={onResumeUndo}
					onfocus={onPauseUndo}
					onblur={onResumeUndo}
				>
					{m.mapping_dismiss()}
				</Button>
			</div>
		{/if}
	</div>

	<div
		class="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 lg:shrink-0 lg:flex-nowrap"
	>
		<Popover.Root
			onOpenChange={(open) => {
				if (open) view.setHighlight(withStarterRule(view.highlight));
			}}
		>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="outline"
						size="sm"
						data-material="glass"
						data-testid="highlight-trigger"
						class="pointer-events-auto min-h-tap border-rule-strong md:min-h-9"
					>
						<HighlighterIcon />
						{m.mapping_highlight()}
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content
				align="start"
				sideOffset={4}
				collisionBoundary={boundary}
				class="max-h-[min(32rem,70vh)] w-[22rem] max-w-full gap-3 overflow-y-auto rounded-surface bg-panel p-3 shadow-[var(--surface-shadow)]"
			>
				<div class="flex items-center justify-between gap-2">
					<p class="field-label px-1">{m.mapping_highlight()}</p>
					<Button
						variant="ghost"
						size="sm"
						class="min-h-tap md:min-h-9"
						data-testid="highlight-clear"
						onclick={() => {
							view.clearHighlight();
							view.setHighlight(starterQuery());
						}}>{m.mapping_highlight_clear()}</Button
					>
				</div>
				<MapHighlightGroup
					root={view.highlight}
					group={view.highlight}
					level={1}
					vocabulary={view.highlightVocabulary}
					onChange={(next) => view.setHighlight(next)}
				/>
				<p class="text-sm text-ink-3">{m.mapping_highlight_help()}</p>
			</Popover.Content>
		</Popover.Root>

		<SavedViewsMenu
			views={savedViews}
			{boundary}
			glass
			class="pointer-events-auto min-h-tap border-rule-strong md:min-h-9"
		/>

		<MapFilterPanel
			{view}
			{attributes}
			{languages}
			{attributeById}
			{boundary}
			{hasFilters}
			{activeFilterNameCount}
			{onReset}
			{onClearFilters}
		/>

		{#if view.groupableAttributes.length > 0}
			<Popover.Root>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="outline"
							size="sm"
							data-material="glass"
							class="pointer-events-auto min-h-tap border-rule-strong md:min-h-9"
						>
							{groupButtonLabel}
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content
					align="start"
					sideOffset={4}
					collisionBoundary={boundary}
					class="w-72 max-w-full gap-3 rounded-surface bg-panel p-3 shadow-[var(--surface-shadow)]"
				>
					<div class="flex flex-col gap-1">
						<Field.FieldLabel for="map-group-by" class="field-label px-1"
							>{m.mapping_group_by()}</Field.FieldLabel
						>
						<Select.Root
							type="single"
							items={groupItems}
							value={groupSelection}
							onValueChange={(value) => (view.groupBy = value === noneValue ? '' : value)}
						>
							<Select.Trigger id="map-group-by" class="min-h-tap w-full md:min-h-9">
								<Select.Value />
							</Select.Trigger>
							<Select.Content>
								<Select.Group>
									{#each groupItems as item (item.value)}
										<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
									{/each}
								</Select.Group>
							</Select.Content>
						</Select.Root>
					</div>
					{#if expansionBranches.length > 0}
						{@render expansionRows(expansionBranches, onToggleExpansion, 'map-expansion-primary')}
					{/if}
					{#if expansionRefusal}
						<p data-testid="map-expansion-refusal" role="status" class="text-sm text-ink">
							{expansionRefusalReason}
						</p>
					{/if}
					{#if groupingRefusal && groupingAttribute}
						<div
							data-testid="map-grouping-status"
							role="status"
							class="flex flex-col gap-1 border-t border-rule pt-2 text-sm"
						>
							<p class="text-ink-2">
								{m.mapping_group_fallback({ attribute: groupingAttribute.name })}
							</p>
							<p class="text-ink" data-testid="map-grouping-reason">{groupingReason}</p>
							{#if groupingSuggestions.length > 0}
								<p class="text-ink-2">{m.mapping_group_narrow_hint()}</p>
								<ul class="flex flex-col gap-1">
									{#each groupingSuggestions as suggestion (suggestion.key)}
										<li data-testid="map-grouping-suggestion" class="text-ink">
											{suggestion.label}
										</li>
									{/each}
								</ul>
							{/if}
							<Button
								variant="outline"
								size="sm"
								class="min-h-tap self-start md:min-h-9"
								onclick={onClearGrouping}>{m.mapping_group_clear()}</Button
							>
						</div>
					{/if}
					{#if view.canSubGroup}
						<div class="flex flex-col gap-1">
							<Field.FieldLabel for="map-sub-group-by" class="field-label px-1"
								>{m.mapping_sub_group_by()}</Field.FieldLabel
							>
							<Select.Root
								type="single"
								items={subGroupItems}
								value={subGroupSelection}
								disabled={view.groupingAttribute === undefined}
								onValueChange={(value) => (view.subGroupBy = value === noneValue ? '' : value)}
							>
								<Select.Trigger id="map-sub-group-by" class="min-h-tap w-full md:min-h-9">
									<Select.Value />
								</Select.Trigger>
								<Select.Content>
									<Select.Group>
										{#each subGroupItems as item (item.value)}
											<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
										{/each}
									</Select.Group>
								</Select.Content>
							</Select.Root>
						</div>
						{#if subExpansionBranches.length > 0}
							{@render expansionRows(
								subExpansionBranches,
								onToggleSubExpansion,
								'map-expansion-secondary'
							)}
						{/if}
						{#if subExpansionRefusal}
							<p data-testid="map-sub-expansion-refusal" role="status" class="text-sm text-ink">
								{subExpansionRefusalReason}
							</p>
						{/if}
						{#if subGroupingRefusal && groupingAttribute && subGroupingAttribute}
							<div
								data-testid="map-sub-grouping-status"
								role="status"
								class="flex flex-col gap-1 border-t border-rule pt-2 text-sm"
							>
								<p class="text-ink-2">
									{m.mapping_sub_group_fallback({
										attribute: groupingAttribute.name,
										subAttribute: subGroupingAttribute.name
									})}
								</p>
								<p class="text-ink" data-testid="map-sub-grouping-reason">{subGroupingReason}</p>
								{#if subGroupingSuggestions.length > 0}
									<p class="text-ink-2">{m.mapping_group_narrow_hint()}</p>
									<ul class="flex flex-col gap-1">
										{#each subGroupingSuggestions as suggestion (suggestion.key)}
											<li data-testid="map-sub-grouping-suggestion" class="text-ink">
												{suggestion.label}
											</li>
										{/each}
									</ul>
								{/if}
							</div>
						{/if}
					{/if}
				</Popover.Content>
			</Popover.Root>
		{/if}
		<div
			class="pointer-events-auto flex h-tap items-center gap-1 rounded-control border border-rule-strong p-px md:h-9"
			data-material="glass"
		>
			<IconTip label={m.mapping_zoom_out()}>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-sm"
						class="size-auto h-full w-tap p-0 hover:bg-hover md:w-9"
						aria-label={m.mapping_zoom_out()}
						onclick={() => panZoom.zoomOut()}
					>
						<ZoomOutIcon />
					</Button>
				{/snippet}
			</IconTip>
			<span class="num w-10 text-center text-xs text-ink-3">
				<!-- Relative to the whole-map framing, which reads as 100%. -->
				{Math.round((panZoom.zoom / panZoom.framedZoom) * 100)}%
			</span>
			<IconTip label={m.mapping_zoom_in()}>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-sm"
						class="size-auto h-full w-tap p-0 hover:bg-hover md:w-9"
						aria-label={m.mapping_zoom_in()}
						onclick={() => panZoom.zoomIn()}
					>
						<ZoomInIcon />
					</Button>
				{/snippet}
			</IconTip>
			<Separator orientation="vertical" class="h-5" />
			<IconTip label={m.mapping_reset_zoom()}>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-sm"
						class="size-auto h-full w-tap p-0 hover:bg-hover md:w-9"
						aria-label={m.mapping_reset_zoom()}
						onclick={onResetFrame}
					>
						<MaximizeIcon />
					</Button>
				{/snippet}
			</IconTip>
		</div>
		<!-- Button and keyboard zoom state their level; wheel and drag zoom stay silent. -->
		<p class="sr-only" aria-live="polite">
			{panZoom.announcedZoom === undefined
				? ''
				: m.mapping_zoom_level({ percent: panZoom.announcedZoom })}
		</p>
		{#if groupingRefusal && groupingAttribute}
			<div
				data-testid="map-grouping-fallback"
				data-material="glass"
				role="status"
				class="pointer-events-auto flex w-full items-center gap-2 rounded-item px-3 py-1 text-sm"
			>
				<span class="flex-1">{m.mapping_group_fallback({ attribute: groupingAttribute.name })}</span
				>
				<Button variant="ghost" size="sm" class="min-h-tap md:min-h-9" onclick={onClearGrouping}>
					{m.mapping_group_clear()}
				</Button>
			</div>
		{/if}
	</div>
</div>
