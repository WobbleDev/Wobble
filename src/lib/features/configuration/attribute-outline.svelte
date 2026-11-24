<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { AnswerReorder } from './answer-reorder.svelte.ts';
	import type { AttributePlacement } from './attribute-placement.svelte.ts';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { cn } from '#lib/utils.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import { kindMode } from '#lib/shared/workers/select-mode.ts';
	import { countAnswerPopulation } from '#lib/shared/workers/worker-population.ts';
	import {
		attributeTypeLabel,
		toWorkerAttributeDefinition,
		type AttributeAnswerDraft,
		type AttributeDraft
	} from './attribute-draft.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import {
		getAttributeNameError,
		getAttributeOptionError,
		hasChildAnswers
	} from './attribute-validation.ts';
	import { visibleValues, type ValueTextCheck } from './configuration-draft.ts';
	import AnswerOutline, { type AnswerActions } from './answer-outline.svelte';
	import AttributeTools from './attribute-tools.svelte';
	import ParentRemovalChoice from './parent-removal-choice.svelte';
	import OutlineCount from './outline-count.svelte';

	/**
	 * One Attribute as a treeitem: its own row (name, kind, counts) and, when unfolded,
	 * its answers nested under guide lines plus the Attribute's own settings.
	 * Counts read saved Worker data against the draft's hierarchy, so moving or nesting
	 * an answer regroups them before anything is saved.
	 */
	type Props = {
		attribute: AttributeDraft;
		placement: AttributePlacement;
		answerReorder: AnswerReorder;
		expanded: boolean;
		expandedIds: ReadonlySet<string>;
		saving: boolean;
		workers: readonly Worker[];
		focusedId: string | null;
		onToggleExpanded: (id: string) => void;
		allAttributes: readonly AttributeDraft[];
		onRequestDelete: (id: string) => void;
		onMoveAttribute: (id: string, direction: -1 | 1) => boolean;
		onAddOption: (attribute: AttributeDraft, parentId?: string) => string | null;
		onFocusRow: (id: string) => void;
		onRemoveOption: (attributeId: string, optionId: string, removeBranch?: boolean) => void;
		onRenameOption: (attributeId: string, optionId: string, text: string) => ValueTextCheck;
		abbreviationShown: (answer: AttributeAnswerDraft) => string;
		onEditAbbreviation: (attributeId: string, answerId: string, text: string) => void;
		onDuplicateOption: (
			attributeId: string,
			optionId: string,
			foldingText: string,
			survivorId: string
		) => void;
		onMoveAnswer: (attributeId: string, optionId: string, parentId: string) => void;
		/** The Attribute drag in progress, shared so the target row can draw the drop line. */
		reorder: { id: string; targetId: string | null; after: boolean } | null;
		onStartReorder: (event: PointerEvent, id: string) => void;
		/**
		 * List and detail: this row sits in the list column and its values fill the detail
		 * column beside it. Off, the values nest under the row as a tree (narrow widths,
		 * or more than one Attribute unfolded).
		 */
		detail?: boolean;
		/** Reports the detail block's height (0 when it is folded or not beside the list). */
		onDetailHeight?: (id: string, height: number) => void;
	};

	let {
		attribute,
		placement,
		answerReorder,
		expanded,
		expandedIds,
		saving,
		workers,
		focusedId,
		onToggleExpanded,
		allAttributes,
		onRequestDelete,
		onMoveAttribute,
		onAddOption,
		onFocusRow,
		onRemoveOption,
		onRenameOption,
		abbreviationShown,
		onEditAbbreviation,
		onDuplicateOption,
		onMoveAnswer,
		reorder,
		onStartReorder,
		detail = false,
		onDetailHeight
	}: Props = $props();

	/** The detail block floats beside the list, so the tree needs its height to make room. */
	let detailHeight = $state(0);
	$effect(() => {
		const height = detail && expanded ? detailHeight : 0;
		// The report writes the editor's own state: read nothing back from it here.
		untrack(() => onDetailHeight?.(attribute.id, height));
	});
	$effect(() => {
		const id = attribute.id;
		return () => untrack(() => onDetailHeight?.(id, 0));
	});

	const answers = $derived(visibleValues(attribute.answers));
	const roots = $derived(answers.filter((answer) => !answer.parentId));
	const definition = $derived(toWorkerAttributeDefinition(attribute));
	const counts = $derived(
		countAnswerPopulation(workers, {
			...definition,
			answers: answers.map((answer) => ({
				id: answer.id,
				value: answer.value,
				...(answer.parentId ? { parentId: answer.parentId } : {})
			}))
		})
	);
	const attributeType = $derived(attributeTypeLabel(attribute.type));
	const typeHelp = $derived(
		attribute.type === 'category'
			? m.configuration_single_select_help()
			: m.configuration_multi_select_help()
	);
	const displayName = $derived(attribute.name || m.configuration_attribute_untitled());
	const accessibleName = $derived(`${displayName}, ${attributeType}`);
	const expandable = $derived(roots.length > 0);
	/** Arrow keys on the handle step the Attribute one place. */
	function reorderKeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		event.preventDefault();
		onMoveAttribute(attribute.id, event.key === 'ArrowUp' ? -1 : 1);
	}

	const reordering = $derived(reorder?.id === attribute.id);
	const dropEdge = $derived(
		reorder?.targetId === attribute.id ? (reorder.after ? 'bottom' : 'top') : null
	);

	/** The parent answer whose removal is waiting on a choice for its children. */
	let pendingRemovalId = $state('');
	let editingName = $state(false);
	let nameDraft = $state('');
	let nameError = $state('');
	let nameButton = $state<HTMLButtonElement>();

	function requestRemove(optionId: string) {
		if (hasChildAnswers(attribute, optionId)) {
			pendingRemovalId = optionId;
			return;
		}
		onRemoveOption(attribute.id, optionId);
	}

	function startNameEdit() {
		nameDraft = attribute.name;
		nameError = '';
		editingName = true;
	}

	function commitNameEdit(restoreFocus = false) {
		if (!editingName) return;
		const nextName = nameDraft.trim();
		nameError = getAttributeNameError(nextName, allAttributes, attribute.id);
		if (nameError) return;
		attribute.name = nextName;
		editingName = false;
		if (restoreFocus) void tick().then(() => nameButton?.focus());
	}

	function cancelNameEdit() {
		nameDraft = attribute.name;
		nameError = '';
		editingName = false;
		void tick().then(() => nameButton?.focus());
	}

	function toggleType() {
		// The Attribute's setting governs only its top level (ADR 0043): a value with
		// sub-values and no mode of its own keeps the mode it has been following.
		const following = kindMode(attribute.type);
		for (const answer of attribute.answers) {
			if (!answer.mode && hasChildAnswers(attribute, answer.id)) answer.mode = following;
		}
		attribute.type = attribute.type === 'category' ? 'tag' : 'category';
	}

	const answerActions: AnswerActions = {
		get pendingRemovalId() {
			return pendingRemovalId;
		},
		hasError: (answer) => Boolean(getAttributeOptionError(attribute, answer)),
		onRename: (answerId, text) => onRenameOption(attribute.id, answerId, text),
		abbreviationShown: (answer) => abbreviationShown(answer),
		onAbbreviation: (answerId, text) => onEditAbbreviation(attribute.id, answerId, text),
		onDuplicate: (answerId, text, survivorId) =>
			onDuplicateOption(attribute.id, answerId, text, survivorId),
		onRequestRemove: requestRemove,
		get reorder() {
			return answerReorder;
		},
		removalChoice
	};

	const rowColumns =
		'grid-cols-[1.5rem_minmax(0,1fr)_3.5rem_1.75rem] @max-[20rem]:grid-cols-[2.75rem_minmax(0,1fr)_3rem_1.75rem]';

	/** List and detail: a click on the row's own space selects it; its controls keep their own clicks. */
	function selectFromRow(event: MouseEvent) {
		if (!detail || saving) return;
		if ((event.target as HTMLElement).closest('button, input, a')) return;
		onToggleExpanded(attribute.id);
	}
</script>

{#snippet removalChoice(parent: AttributeAnswerDraft)}
	<ParentRemovalChoice
		attributeId={attribute.id}
		{parent}
		{answers}
		onRemoveOption={(optionId, removeBranch) =>
			onRemoveOption(attribute.id, optionId, removeBranch)}
		onMoveAnswer={(optionId, parentId) => onMoveAnswer(attribute.id, optionId, parentId)}
		onClose={() => (pendingRemovalId = '')}
	/>
{/snippet}

<div
	role="treeitem"
	aria-selected="false"
	aria-level="1"
	aria-expanded={expandable ? expanded : undefined}
	aria-label={accessibleName}
	tabindex={focusedId === attribute.id ? 0 : -1}
	data-testid="attribute-row"
	data-attribute-id={attribute.id}
	data-row-id={attribute.id}
	data-level="1"
	class={cn(
		'group/item relative outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
		// List and detail: the item is just its row, one list column wide; the values are
		// placed beside it from the tree's own corner (see the detail block below).
		detail && '@2xl:static @2xl:w-64'
	)}
	class:opacity-40={reordering}
	onfocus={() => onFocusRow(attribute.id)}
>
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		class={cn(
			`group/row relative grid ${rowColumns} min-h-10 items-center gap-1 px-1 coarse:min-h-tap`,
			// List and detail: no dropdown arrow; the whole row selects, and a slim bar marks the pick.
			detail &&
				'@2xl:cursor-pointer @2xl:grid-cols-[0.75rem_minmax(0,1fr)_3.5rem_1.75rem] @2xl:rounded-item',
			detail && (expanded ? '@2xl:bg-inset' : '@2xl:hover:bg-hover')
		)}
		onclick={selectFromRow}
	>
		{#if dropEdge}
			<span
				aria-hidden="true"
				data-testid="placement-drop-indicator"
				class={`pointer-events-none absolute right-2 left-[2.25rem] z-10 flex items-center gap-1 ${dropEdge === 'top' ? '-top-1' : '-bottom-1'}`}
			>
				<span class="size-1.5 shrink-0 rounded-full bg-action"></span>
				<span class="h-px flex-1 bg-action"></span>
			</span>
		{/if}
		<button
			type="button"
			class={cn(
				'group flex size-8 items-center justify-center rounded-item p-0 coarse:size-tap',
				detail && '@2xl:w-3!'
			)}
			aria-label={m.configuration_attribute_toggle({ name: displayName })}
			aria-expanded={expanded}
			aria-controls={`${attribute.id}-answers`}
			disabled={saving}
			onclick={() => onToggleExpanded(attribute.id)}
		>
			<span
				class={cn(
					'flex size-6 items-center justify-center rounded-sm group-hover:bg-hover',
					detail && '@2xl:hidden'
				)}
			>
				<ChevronDownIcon class={`size-4 transition-transform ${expanded ? '' : '-rotate-90'}`} />
			</span>
			{#if detail}
				<span
					aria-hidden="true"
					class={cn(
						'hidden h-5 w-1 rounded-full @2xl:block',
						expanded ? 'bg-action' : 'bg-transparent'
					)}
				></span>
			{/if}
		</button>

		<div class="flex min-w-0 flex-wrap items-center gap-1">
			<button
				type="button"
				data-testid="attribute-reorder"
				data-action="reorder"
				class={`flex size-7 shrink-0 touch-none items-center justify-center rounded-sm text-ink-3 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30 coarse:size-tap ${reordering ? 'cursor-grabbing' : 'cursor-grab'}`}
				aria-label={m.configuration_attribute_reorder_handle({ name: displayName })}
				title={m.configuration_attribute_reorder_handle({ name: displayName })}
				disabled={saving}
				onpointerdown={(event) => onStartReorder(event, attribute.id)}
				onkeydown={reorderKeydown}
			>
				<GripVerticalIcon class="size-3.5" />
			</button>
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1">
				{#if editingName}
					<Input
						bind:value={nameDraft}
						class="min-h-8 min-w-0 flex-1 px-2 py-1 text-sm md:min-h-8"
						aria-label={m.configuration_attribute_name()}
						aria-invalid={Boolean(nameError)}
						aria-describedby={nameError ? `${attribute.id}-name-error` : undefined}
						autofocus
						oninput={() =>
							(nameError = getAttributeNameError(nameDraft, allAttributes, attribute.id))}
						onkeydown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								commitNameEdit(true);
							} else if (event.key === 'Escape') {
								event.preventDefault();
								event.stopPropagation();
								cancelNameEdit();
							}
						}}
						onblur={() => commitNameEdit()}
					/>
				{:else}
					<div
						class="relative min-w-0 flex-[0_1_auto]"
						data-placement-attribute={attribute.id}
						data-placement-parent=""
					>
						<div class="min-w-0">
							<button
								bind:this={nameButton}
								type="button"
								class={`max-w-full min-w-0 truncate rounded-sm text-left text-sm font-medium underline decoration-transparent underline-offset-4 hover:decoration-ink-3 focus-visible:decoration-ink coarse:min-h-tap ${placement.isDestination(attribute.id, '') ? 'bg-hover' : ''}`}
								aria-label={m.configuration_attribute_rename({ name: displayName })}
								title={`${displayName} — ${attributeType}: ${typeHelp}`}
								onclick={startNameEdit}
							>
								{displayName}
							</button>
						</div>
						{#if placement.source && placement.eligible( { attributeId: attribute.id, parentId: '' } )}
							<button
								type="button"
								class="absolute inset-0 z-10 rounded-sm"
								aria-label={m.configuration_placement_root({ name: displayName })}
							></button>
						{/if}
					</div>
				{/if}
				{#if !editingName}
					<button
						type="button"
						class="shrink-0 rounded-full bg-inset px-2.5 text-xs leading-6 text-ink-2 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-tap"
						aria-label={m.configuration_attribute_type_toggle({
							current: attributeType,
							next: attribute.type === 'category' ? m.domain_tag() : m.domain_category()
						})}
						aria-pressed={attribute.type === 'tag'}
						title={`${attributeType}: ${typeHelp}`}
						onclick={toggleType}
					>
						{attributeType}
					</button>
				{/if}
				{#if nameError}
					<div class="basis-full">
						<Field.Error id={`${attribute.id}-name-error`}>{nameError}</Field.Error>
					</div>
				{/if}
			</div>
		</div>

		<OutlineCount count={counts.workersAnswering} />
		<button
			type="button"
			class="flex size-tap shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-state-error/10 hover:text-state-error focus-visible:text-state-error focus-visible:ring-2 focus-visible:ring-ring md:size-7 coarse:min-h-tap coarse:min-w-tap [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/row:opacity-100 [@media(hover:hover)]:group-hover/row:opacity-100"
			aria-label={m.configuration_delete_named({
				name: attribute.name || m.configuration_attribute_fallback()
			})}
			title={m.configuration_delete_named({
				name: attribute.name || m.configuration_attribute_fallback()
			})}
			disabled={saving}
			onclick={() => onRequestDelete(attribute.id)}
		>
			<Trash2Icon class="size-4" />
		</button>
		{#if placement.isDestination(attribute.id, '')}
			<span
				aria-hidden="true"
				data-testid="placement-drop-indicator"
				class="pointer-events-none absolute right-2 -bottom-1 left-[2.25rem] z-10 flex items-center gap-1"
			>
				<span class="size-1.5 shrink-0 rounded-full bg-action"></span>
				<span class="h-px flex-1 bg-action"></span>
			</span>
		{/if}
	</div>

	{#if expanded}
		<!-- In list and detail, the whole block fills the detail column beside the list. -->
		<div
			bind:clientHeight={detailHeight}
			class={cn(detail && '@2xl:absolute @2xl:top-1.5 @2xl:right-0 @2xl:left-[17.5rem]')}
			class:opacity-40={reordering}
		>
			<!-- One guide line for the root answers' level (a tree only; the detail has its own column). -->
			<div
				id={`${attribute.id}-answers`}
				role="group"
				data-testid="attribute-answers"
				class={cn(
					'ml-4 border-l border-rule pl-2 @max-[28rem]:ml-1 @max-[28rem]:pl-1',
					detail && '@2xl:ml-0 @2xl:border-l-0 @2xl:pl-0'
				)}
			>
				{#each roots as answer (answer.id)}
					<AnswerOutline
						{answer}
						{placement}
						attributeId={attribute.id}
						attributeType={attribute.type}
						depth={2}
						allAnswers={answers}
						{expandedIds}
						{counts}
						disabled={saving}
						{focusedId}
						actions={answerActions}
						{onToggleExpanded}
						{onFocusRow}
					/>
				{/each}
				{#if !roots.length}
					<p class="px-2 py-1.5 text-sm text-ink-3">{m.configuration_no_answers()}</p>
				{/if}
			</div>
			{#if placement.destination?.attributeId === attribute.id}
				<div
					class="sticky bottom-0 z-20 ml-4 grid min-w-0 gap-0.5 bg-panel py-1 pl-2 text-xs leading-4 text-ink-2"
					data-testid="placement-preview"
				>
					<span class="truncate font-medium" title={placement.destinationLabel}
						>{placement.destinationLabel}</span
					>
					<span class="min-w-0 pl-2 break-words"
						>{m.configuration_placement_preview({ name: placement.sourceLeafLabel })}</span
					>
				</div>
			{/if}
			{#if attribute.moveError}
				<div class="ml-4 pl-2"><Field.Error>{attribute.moveError}</Field.Error></div>
			{/if}
			{#if attribute.removalError}
				<div class="ml-4 pl-2"><Field.Error>{attribute.removalError}</Field.Error></div>
			{/if}
			<AttributeTools {attribute} {saving} {onAddOption} {placement} />
		</div>
	{/if}
	{#if !expanded && placement.destination?.attributeId === attribute.id}
		<div
			class={cn(
				'sticky bottom-0 z-20 ml-4 grid min-w-0 gap-0.5 bg-panel py-1 pl-2 text-xs leading-4 text-ink-2',
				detail && '@2xl:w-64'
			)}
			data-testid="placement-preview"
		>
			<span class="truncate font-medium" title={placement.destinationLabel}
				>{placement.destinationLabel}</span
			>
			<span class="min-w-0 pl-2 break-words"
				>{m.configuration_placement_preview({ name: placement.sourceLeafLabel })}</span
			>
		</div>
	{/if}
</div>
