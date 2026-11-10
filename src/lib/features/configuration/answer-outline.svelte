<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { AttributeAnswerDraft, AttributeType } from './attribute-draft.ts';
	import type { ValueTextCheck } from './configuration-draft.ts';

	/** What a row does with an answer, passed down the recursion as one bundle. */
	export type AnswerActions = {
		pendingRemovalId: string;
		hasError: (answer: AttributeAnswerDraft) => boolean;
		onRename: (answerId: string, text: string) => ValueTextCheck;
		/** The text the answer's Short form field shows. */
		shortFormShown: (answer: AttributeAnswerDraft) => string;
		onShortForm: (answerId: string, text: string) => void;
		onDuplicate: (answerId: string, text: string, survivorId: string) => void;
		onRequestRemove: (answerId: string) => void;
		reorder: AnswerReorder;
		/** Renders the parent-removal choice directly under the row whose removal is pending. */
		removalChoice: Snippet<[AttributeAnswerDraft]>;
	};
</script>

<script lang="ts">
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import type { AnswerReorder } from './answer-reorder.svelte.ts';
	import type { AttributePlacement } from './attribute-placement.svelte.ts';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { m } from '#lib/paraglide/messages.js';
	import { answerDisplayLabel, answerPathLabel } from '#lib/shared/answer-path.ts';
	import { kindMode } from '#lib/shared/select-mode.ts';
	import type { AnswerPopulationCounts } from '#lib/shared/worker-population.ts';
	import EditableChip from './editable-chip.svelte';
	import OutlineCount from './outline-count.svelte';
	import ShortFormField from './short-form-field.svelte';
	import Self from './answer-outline.svelte';

	/**
	 * One answer of an Attribute's outline, and its subtree. The answer is a treeitem
	 * wrapping its own group, so its level and expanded state are exposed where the
	 * browser looks for them; the group draws the guide line for the next level.
	 */
	type Props = {
		answer: AttributeAnswerDraft;
		placement: AttributePlacement;
		attributeId: string;
		/** The Attribute's own type: the select mode its top level and unmoded values follow. */
		attributeType: AttributeType;
		/** Root answers sit one level below their Attribute. */
		depth: number;
		allAnswers: readonly AttributeAnswerDraft[];
		expandedIds: ReadonlySet<string>;
		counts: AnswerPopulationCounts;
		disabled: boolean;
		focusedId: string | null;
		actions: AnswerActions;
		onToggleExpanded: (id: string) => void;
		onFocusRow: (id: string) => void;
	};

	let {
		answer,
		placement,
		attributeId,
		attributeType,
		depth,
		allAnswers,
		expandedIds,
		counts,
		disabled,
		focusedId,
		actions,
		onToggleExpanded,
		onFocusRow
	}: Props = $props();

	const children = $derived(allAnswers.filter((candidate) => candidate.parentId === answer.id));
	const expandable = $derived(children.length > 0);
	const expanded = $derived(expandedIds.has(answer.id));
	const label = $derived(answerDisplayLabel(allAnswers, answer.id));
	const chipLabel = $derived(label || m.configuration_option_fallback());
	const workerCount = $derived(counts.workers.get(answer.id) ?? 0);
	const directWorkers = $derived(counts.directWorkers.get(answer.id) ?? 0);
	const remainderId = $derived(`${answer.id}~remainder`);
	/** The select mode this value's own sub-values follow (ADR 0043). */
	const selectMode = $derived(answer.mode ?? kindMode(attributeType));
	const selectModeName = $derived(selectMode === 'single' ? m.domain_category() : m.domain_tag());
	const nextModeName = $derived(selectMode === 'single' ? m.domain_tag() : m.domain_category());
	const selectModeHelp = $derived(
		selectMode === 'single'
			? m.configuration_single_select_help()
			: m.configuration_multi_select_help()
	);
	function toggleSelectMode() {
		// Back at the Attribute's own default, the value follows the Attribute again.
		const next = selectMode === 'single' ? 'multi' : 'single';
		answer.mode = next === kindMode(attributeType) ? undefined : next;
	}
	const rowColumns =
		'grid-cols-[1.5rem_minmax(0,1fr)_3.5rem_1.75rem] @max-[20rem]:grid-cols-[2.75rem_minmax(0,1fr)_3rem_1.75rem]';
</script>

<div
	role="treeitem"
	aria-selected="false"
	aria-level={depth}
	aria-expanded={expandable ? expanded : undefined}
	aria-label={label}
	tabindex={focusedId === answer.id ? 0 : -1}
	data-testid="answer-row"
	data-answer-id={answer.id}
	data-row-id={answer.id}
	data-parent-row-id={answer.parentId ?? attributeId}
	data-depth={depth}
	class="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
	class:opacity-40={placement.isDraggingAnswer(answer.id)}
	onfocus={() => onFocusRow(answer.id)}
>
	<div
		data-reorder-row={answer.id}
		data-reorder-attribute={attributeId}
		class={`group/row relative grid ${rowColumns} min-h-9 items-center gap-1 rounded-item px-1 coarse:min-h-tap`}
	>
		{#if placement.dropEdge(answer.id)}
			<span
				aria-hidden="true"
				data-testid="placement-drop-indicator"
				class={`pointer-events-none absolute right-2 left-[2.25rem] z-10 flex items-center gap-1 ${placement.dropEdge(answer.id) === 'top' ? '-top-1' : '-bottom-1'}`}
			>
				<span class="size-1.5 shrink-0 rounded-full bg-action"></span>
				<span class="h-px flex-1 bg-action"></span>
			</span>
		{/if}
		{#if expandable}
			<button
				type="button"
				class="flex size-8 items-center justify-center rounded-item p-0 hover:bg-hover coarse:size-tap"
				aria-label={m.configuration_answer_toggle({ name: label })}
				aria-expanded={expanded}
				aria-controls={`${answer.id}-answers`}
				{disabled}
				onclick={() => onToggleExpanded(answer.id)}
			>
				<ChevronDownIcon class={`size-4 transition-transform ${expanded ? '' : '-rotate-90'}`} />
			</button>
		{:else}
			<span></span>
		{/if}
		<div class="flex min-w-0 flex-wrap items-center gap-x-0.5 gap-y-1">
			<!-- The handle and the name wrap as one, so a narrow row moves the field down, not the handle. -->
			<div class="flex min-w-0 flex-1 basis-40 items-center gap-0.5">
				<button
					type="button"
					data-placement-handle={answer.id}
					class="flex size-7 shrink-0 touch-none items-center justify-center rounded-sm text-ink-3 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring coarse:size-tap"
					class:cursor-grabbing={placement.isDraggingAnswer(answer.id) && !placement.refusal}
					class:cursor-not-allowed={placement.isDraggingAnswer(answer.id) &&
						Boolean(placement.refusal)}
					aria-label={m.configuration_placement_handle({
						name: answerPathLabel(allAnswers, answer.id)
					})}
					aria-pressed={(placement.source?.kind === 'answer' &&
						placement.source.answerId === answer.id) ||
						actions.reorder.isHeld(answer.id)}
					{disabled}
					onkeydown={(event) => actions.reorder.keydown(event, attributeId, answer.id)}
					onkeyup={(event) => {
						// Space activates a button on release; the keydown already used it.
						if (event.key === ' ') event.preventDefault();
					}}
					onblur={() => actions.reorder.blur(answer.id)}
					onpointerdown={(event) =>
						placement.pointerDown(event, { kind: 'answer', attributeId, answerId: answer.id })}
					onclick={() =>
						placement.clickHandle({ kind: 'answer', attributeId, answerId: answer.id })}
					><GripVerticalIcon class="size-3.5" /></button
				>
				<div
					class="relative min-w-0 flex-1 rounded-sm"
					data-placement-attribute={attributeId}
					data-placement-parent={answer.id}
				>
					{#if placement.source && placement.eligible({ attributeId, parentId: answer.id })}
						<button
							type="button"
							class="absolute inset-0 z-10 rounded-sm"
							aria-label={m.configuration_placement_under({
								name: answerPathLabel(allAnswers, answer.id)
							})}
						></button>
					{/if}
					<EditableChip
						variant="row"
						removable={false}
						destination={placement.isDestination(attributeId, answer.id)}
						path={answerPathLabel(allAnswers, answer.id)}
						text={answer.value || m.configuration_untitled_option()}
						editLabel={m.configuration_edit_value({ name: chipLabel })}
						removeLabel={m.configuration_remove_value({ name: chipLabel })}
						error={actions.hasError(answer)}
						{disabled}
						onRemove={() => actions.onRequestRemove(answer.id)}
						onRename={(text) => actions.onRename(answer.id, text)}
						onDuplicate={(text, survivorId) => actions.onDuplicate(answer.id, text, survivorId)}
					/>
				</div>
			</div>
			<ShortFormField
				name={chipLabel}
				shown={actions.shortFormShown(answer)}
				edited={answer.shortFormOrigin === 'edited'}
				{disabled}
				onInput={(text) => actions.onShortForm(answer.id, text)}
			/>
			{#if expandable}
				<button
					type="button"
					class="shrink-0 rounded-full bg-inset px-2 text-xs leading-6 text-ink-2 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-tap"
					data-testid="answer-select-mode"
					aria-label={m.configuration_select_mode_toggle({
						name: label,
						current: selectModeName,
						next: nextModeName
					})}
					aria-pressed={selectMode === 'multi'}
					title={`${selectModeName}: ${selectModeHelp}`}
					{disabled}
					onclick={toggleSelectMode}
				>
					{selectModeName}
				</button>
			{/if}
		</div>
		<div class="@max-[20rem]:col-start-3 @max-[20rem]:row-start-1">
			<OutlineCount count={workerCount} />
		</div>
		<button
			type="button"
			class="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm p-0 text-ink-3 hover:bg-state-error/10 hover:text-state-error focus-visible:text-state-error focus-visible:ring-2 focus-visible:ring-ring coarse:size-tap [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/row:opacity-100 [@media(hover:hover)]:group-hover/row:opacity-100"
			aria-label={m.configuration_remove_value({ name: chipLabel })}
			title={m.configuration_remove_value({ name: chipLabel })}
			data-action="remove"
			tabindex={-1}
			{disabled}
			onclick={() => actions.onRequestRemove(answer.id)}
		>
			<Trash2Icon class="size-4" />
		</button>
		{#if placement.isDestination(attributeId, answer.id)}
			<span
				aria-hidden="true"
				data-testid="placement-drop-indicator"
				class="pointer-events-none absolute right-2 -bottom-1 left-[4.5rem] z-10 flex items-center gap-1 @max-[20rem]:left-12"
			>
				<span class="size-1.5 shrink-0 rounded-full bg-action"></span>
				<span class="h-px flex-1 bg-action"></span>
			</span>
		{/if}
	</div>

	{#if actions.pendingRemovalId === answer.id}
		{@render actions.removalChoice(answer)}
	{/if}

	{#if expandable && expanded}
		<!-- One guide line for the level these children sit on. -->
		<div
			id={`${answer.id}-answers`}
			role="group"
			class="ml-4 border-l border-rule pl-2 @max-[28rem]:ml-1 @max-[28rem]:pl-1"
		>
			{#each children as child (child.id)}
				<Self
					answer={child}
					{placement}
					{attributeId}
					{attributeType}
					depth={depth + 1}
					{allAnswers}
					{expandedIds}
					{counts}
					{disabled}
					{focusedId}
					{actions}
					{onToggleExpanded}
					{onFocusRow}
				/>
			{/each}
			{#if directWorkers > 0}
				<div
					role="treeitem"
					aria-selected="false"
					aria-level={depth + 1}
					aria-label={m.configuration_no_further_detail({ name: label })}
					tabindex={focusedId === remainderId ? 0 : -1}
					data-testid="remainder-row"
					data-answer-id={answer.id}
					data-row-id={remainderId}
					data-parent-row-id={answer.id}
					data-depth={depth + 1}
					class="outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					onfocus={() => onFocusRow(remainderId)}
				>
					<div
						class={`grid ${rowColumns} min-h-9 items-center gap-1 px-1 text-ink-2 coarse:min-h-tap`}
					>
						<span></span>
						<span class="min-w-0 truncate text-sm">
							{m.configuration_no_further_detail({ name: label })}
						</span>
						<OutlineCount count={directWorkers} />
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
