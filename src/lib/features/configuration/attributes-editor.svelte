<script lang="ts">
	import { tick, untrack } from 'svelte';
	import BanIcon from '@lucide/svelte/icons/ban';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import { createAttributePlacement } from './attribute-placement.svelte.ts';
	import { createAnswerReorder } from './answer-reorder.svelte.ts';
	import { answerPathLabel } from '#lib/shared/workers/answer-path.ts';
	import { visibleValues } from './configuration-draft.ts';
	import { createOutlineTree } from './outline-tree.svelte.ts';
	import { cn } from '#lib/utils.ts';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { AttributeAnswerDraft, AttributeDraft } from './attribute-draft.ts';
	import type { MoveSource, MoveTarget } from './attribute-moves.ts';
	import AttributeOutline from './attribute-outline.svelte';
	import MergeConfirmDialog from './merge-confirm-dialog.svelte';
	import type { ValueTextCheck } from './configuration-draft.ts';

	/** Where list and detail begins: 42rem, the container width the Attributes card switches at. */
	const DETAIL_MIN_WIDTH = 672;

	type Props = {
		/** The Attributes in this column, in configured order. */
		attributes: AttributeDraft[];
		/** Every Attribute in the list, for the unique-name check. */
		allAttributes: AttributeDraft[];
		/** The column heading, which names the tree for assistive technology. */
		treeLabel: string;
		expandedIds: ReadonlySet<string>;
		saving: boolean;
		workers: readonly Worker[];
		onToggleExpanded: (id: string) => void;
		onRequestDelete: (id: string) => void;
		onMoveAttribute: (id: string, direction: -1 | 1) => boolean;
		onAddOption: (attribute: AttributeDraft, parentId?: string, value?: string) => string | null;
		onRemoveOption: (attributeId: string, optionId: string, removeBranch?: boolean) => void;
		onRenameOption: (attributeId: string, optionId: string, text: string) => ValueTextCheck;
		onMergeOption: (attributeId: string, foldedId: string, survivorId: string) => void;
		abbreviationShown: (answer: AttributeAnswerDraft) => string;
		onEditAbbreviation: (attributeId: string, answerId: string, text: string) => void;
		onMoveAnswer: (attributeId: string, optionId: string, parentId: string) => void;
		/** Moves an answer branch under a row of another Attribute (or its top level). */
		onMoveAnswerToAttribute: (source: MoveSource, target: MoveTarget) => boolean;
		/** Turns an answer branch into an Attribute of its own. */
		onPromoteAnswer: (source: MoveSource) => boolean;
		/** Moves a value among its siblings; its new place, or null at an end. */
		onMoveAnswerSibling: (
			attributeId: string,
			answerId: string,
			direction: -1 | 1
		) => { position: number; count: number } | null;
		onMoveAnswerBeside: (
			attributeId: string,
			answerId: string,
			targetId: string,
			after: boolean
		) => boolean;
		answerSiblingPlace: (
			attributeId: string,
			answerId: string
		) => { position: number; count: number };
		answerOrder: (attributeId: string) => string[];
		onRestoreAnswerOrder: (attributeId: string, order: string[]) => void;
	};

	let {
		attributes,
		allAttributes,
		treeLabel,
		expandedIds,
		saving,
		workers,
		onToggleExpanded,
		onRequestDelete,
		onMoveAttribute,
		onAddOption,
		onRemoveOption,
		onRenameOption,
		onMergeOption,
		abbreviationShown,
		onEditAbbreviation,
		onMoveAnswer,
		onMoveAnswerToAttribute,
		onPromoteAnswer,
		onMoveAnswerSibling,
		onMoveAnswerBeside,
		answerSiblingPlace,
		answerOrder,
		onRestoreAnswerOrder
	}: Props = $props();

	/**
	 * List and detail shows one Attribute's values beside the list. Unfolding a second
	 * Attribute (a drag opening its target, or a value being placed) keeps both open and
	 * the outline falls back to a tree, so nothing a move needs is ever hidden.
	 */
	const unfoldedCount = $derived(
		attributes.filter((attribute) => expandedIds.has(attribute.id)).length
	);
	/** The column's width: list and detail needs room for the list and the values side by side. */
	let columnWidth = $state(0);
	const listAndDetail = $derived(columnWidth >= DETAIL_MIN_WIDTH);
	const detail = $derived(listAndDetail && unfoldedCount <= 1);
	/** A click or key on an Attribute row selects it: the open one folds away. */
	function selectOrToggle(id: string) {
		const isAttribute = attributes.some((attribute) => attribute.id === id);
		// List and detail shows every value, so a value has no fold to toggle.
		if (detail && !isAttribute) return;
		if (isAttribute && !expandedIds.has(id) && !placement.source) {
			for (const other of attributes) {
				if (other.id !== id && expandedIds.has(other.id)) onToggleExpanded(other.id);
			}
		}
		onToggleExpanded(id);
	}

	/** The detail block's height per Attribute (only one is beside the list at a time). */
	let detailHeights = $state<Record<string, number>>({});
	const detailHeight = $derived(Math.max(0, ...Object.values(detailHeights)));

	let tree = $state<HTMLElement | null>(null);
	/** The whole column, which holds the tree and the promote zone the placement listens on. */
	let column = $state<HTMLElement | null>(null);
	const placement = createAttributePlacement({
		get attributes() {
			return attributes;
		},
		get root() {
			return column;
		},
		get disabled() {
			return saving;
		},
		get expandedIds() {
			return expandedIds;
		},
		expand: (id) => onToggleExpanded(id),
		move: (attributeId, answerId, parentId) => onMoveAnswer(attributeId, answerId, parentId),
		moveToAttribute: (source, target) => onMoveAnswerToAttribute(source, target),
		promote: (source) => onPromoteAnswer(source),
		reorderBeside: (attributeId, answerId, targetId, after) =>
			onMoveAnswerBeside(attributeId, answerId, targetId, after),
		create: (attributeId, value, parentId) => {
			const attribute = attributes.find((candidate) => candidate.id === attributeId);
			if (!attribute || attribute.newOption.trim() !== value.trim()) return null;
			return onAddOption(attribute, parentId);
		}
	});
	const answerReorder = createAnswerReorder({
		disabled: () => saving,
		order: (attributeId) => answerOrder(attributeId),
		move: (attributeId, answerId, direction) =>
			onMoveAnswerSibling(attributeId, answerId, direction),
		place: (attributeId, answerId) => answerSiblingPlace(attributeId, answerId),
		restore: (attributeId, order) => onRestoreAnswerOrder(attributeId, order),
		name(attributeId, answerId) {
			const attribute = attributes.find((candidate) => candidate.id === attributeId);
			return answerPathLabel(visibleValues(attribute?.answers ?? []), answerId);
		},
		async focusGrip(answerId) {
			await tick();
			column?.querySelector<HTMLElement>(`[data-placement-handle="${answerId}"]`)?.focus();
		}
	});
	const outline = createOutlineTree({
		rows() {
			return [...(tree?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].map((item) => ({
				id: item.dataset.rowId ?? '',
				level: Number(item.getAttribute('aria-level')),
				parentId: item.dataset.parentRowId ?? null,
				expandable: item.hasAttribute('aria-expanded'),
				expanded: item.getAttribute('aria-expanded') === 'true'
			}));
		},
		focus(id) {
			tree?.querySelector<HTMLElement>(`[role="treeitem"][data-row-id="${id}"]`)?.focus();
		},
		toggleExpanded: (id) => selectOrToggle(id),
		moveAttribute: (id, direction) => onMoveAttribute(id, direction),
		attributeName: (id) => attributes.find((attribute) => attribute.id === id)?.name.trim() ?? '',
		activate(id, action) {
			const control = tree?.querySelector<HTMLButtonElement | HTMLInputElement>(
				`[role="treeitem"][data-row-id="${id}"] > div:first-child [data-action="${action}"]`
			);
			if (!control || control.disabled) return false;
			// The Abbreviation is a field: activating it moves focus in rather than clicking.
			if (control instanceof HTMLInputElement) control.focus();
			else control.click();
			return true;
		},
		rowAtPoint(x, y) {
			const row = document
				.elementFromPoint(x, y)
				?.closest<HTMLElement>('[role="treeitem"][data-level="1"]');
			if (!row) return null;
			// The row itself, not the item: in list and detail the item has no box of its own.
			const box = row.getBoundingClientRect();
			return { id: row.dataset.rowId ?? '', top: box.top, height: box.height };
		},
		rowOwnedBy(target) {
			if (!(target instanceof Element) || !target.matches('[role="treeitem"]')) return null;
			return (target as HTMLElement).dataset.rowId ?? null;
		},
		disabled: () => saving,
		afterUpdate: () => tick()
	});
	const resolvedFocusId = $derived(outline.focusedRowId ?? attributes[0]?.id ?? null);
	const reorder = $derived(outline.reorder);
	const reorderLabel = $derived(
		attributes.find((attribute) => attribute.id === reorder?.id)?.name.trim() ||
			m.configuration_attribute_fallback()
	);

	const rowColumns =
		'grid-cols-[1.5rem_minmax(0,1fr)_3.5rem_var(--row-actions-w)] @max-[20rem]:grid-cols-[2.75rem_minmax(0,1fr)_3rem_var(--row-actions-w)]';

	/** A duplicate answer edit waiting for confirmation: where it is, the folded text, and the survivor. */
	let pendingMerge = $state<{
		attributeId: string;
		foldedId: string;
		foldingText: string;
		survivorId: string;
	} | null>(null);
	const pendingAttribute = $derived(
		attributes.find((attribute) => attribute.id === pendingMerge?.attributeId)
	);
	const pendingSurvivorText = $derived(
		pendingAttribute?.answers.find((answer) => answer.id === pendingMerge?.survivorId)?.value ?? ''
	);

	// List and detail opens on the first Attribute instead of an empty value pane. The
	// selection is made through the same function a click uses, without taking focus; a
	// deliberate collapse is left alone until the Attribute list itself changes.
	let autoSelectedInDetail = false;
	let lastAttributeOrder = '';
	$effect(() => {
		if (!detail) {
			autoSelectedInDetail = false;
			lastAttributeOrder = '';
			return;
		}
		const order = attributes.map((attribute) => attribute.id).join('\u0000');
		const listChanged = order !== lastAttributeOrder;
		lastAttributeOrder = order;
		if (!attributes.length) return;
		if (attributes.some((attribute) => expandedIds.has(attribute.id))) {
			autoSelectedInDetail = true;
			return;
		}
		if (autoSelectedInDetail && !listChanged) return;
		autoSelectedInDetail = true;
		untrack(() => selectOrToggle(attributes[0].id));
	});

	// A row that folded away, or an Attribute that was deleted, must not leave the
	// column's roving treeitem tab stop pointing at nothing.
	$effect(() => {
		void expandedIds.size;
		void attributes.length;
		outline.reconcile();
	});
</script>

<!--
  One column's Attribute outline, exposed as a tree: the column heading names it, each
  row is a treeitem with its level and expanded state, and the rows keep one roving
  treeitem tab stop for arrow-key walking. Each row's own controls (toggle, reorder, name,
  kind, delete) stay ordinary tab stops so every action remains reachable; the tree
  handler moves between rows only while a row itself has focus. The count column heads sit
  on this recess so every row below them lines up with what it is counting. An answer
  being placed can also be made an Attribute of its own from the promote zone under the tree.
-->
<div
	class="grid min-w-0 gap-0.5 [--abbr-w:7.5rem] [--row-actions-w:3.75rem] coarse:[--row-actions-w:5.75rem]"
	bind:this={column}
	bind:clientWidth={columnWidth}
>
	{#if !detail}
		<div
			class="sticky top-[var(--outline-head,0px)] z-[8] -mx-6 border-b border-rule bg-panel px-7 pb-1"
			aria-hidden="true"
		>
			<div class={`grid ${rowColumns} items-center gap-1`}>
				<span></span>
				<span class="flex min-w-0 items-center justify-between gap-2">
					<span class="key min-w-0 truncate">{m.configuration_attribute_name()}</span>
					<span class="key shrink-0 text-right whitespace-nowrap" data-testid="abbreviation-header"
						>{m.configuration_column_abbreviation()}</span
					>
				</span>
				<span class="key text-right leading-tight hyphens-auto" data-testid="worker-count-header"
					>{m.configuration_column_workers()}</span
				>
				<span></span>
			</div>
		</div>
	{/if}

	<div
		role="tree"
		class={cn('grid gap-1.5 pt-1.5', detail && 'relative content-start gap-0.5 pt-1')}
		style:min-height={detail && detailHeight ? `${detailHeight + 4}px` : undefined}
		class:cursor-grabbing={(placement.dragging && !placement.refusal) || reorder}
		class:cursor-not-allowed={Boolean(placement.dragging && placement.refusal)}
		tabindex="-1"
		aria-label={treeLabel}
		bind:this={tree}
		onkeydown={outline.keydown}
	>
		{#each attributes as attribute (attribute.id)}
			<AttributeOutline
				{attribute}
				{placement}
				{answerReorder}
				expanded={expandedIds.has(attribute.id)}
				{expandedIds}
				{saving}
				{workers}
				focusedId={resolvedFocusId}
				onToggleExpanded={selectOrToggle}
				{detail}
				onDetailHeight={(id, height) => {
					if ((detailHeights[id] ?? 0) !== height) detailHeights[id] = height;
				}}
				onFocusRow={outline.focusIn}
				{allAttributes}
				{onRequestDelete}
				onMoveAttribute={outline.moveAttribute}
				{onAddOption}
				{onRemoveOption}
				{onRenameOption}
				{abbreviationShown}
				{onEditAbbreviation}
				onDuplicateOption={(attributeId, optionId, foldingText, survivorId) => {
					pendingMerge = { attributeId, foldedId: optionId, foldingText, survivorId };
				}}
				{onMoveAnswer}
				{reorder}
				onStartReorder={outline.startReorder}
			/>
		{/each}
	</div>

	{#if placement.source?.kind === 'answer'}
		<div
			data-placement-attribute=""
			data-placement-parent=""
			data-placement-promote=""
			class:cursor-not-allowed={Boolean(placement.refusal)}
			class="relative mt-1.5 grid min-w-0 gap-0.5 rounded-item border border-dashed border-rule"
		>
			<button
				type="button"
				data-testid="placement-promote-target"
				class={`min-h-tap rounded-item px-3 text-left text-sm font-medium text-ink hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring md:min-h-9 ${placement.isDestination('', '', true) ? 'bg-hover' : ''}`}
				disabled={saving}
			>
				{m.configuration_placement_promote({ name: placement.sourceLeafLabel })}
			</button>
			{#if placement.isDestination('', '', true)}
				<span
					aria-hidden="true"
					data-testid="placement-drop-indicator"
					class="pointer-events-none mx-3 mb-1 flex items-center gap-1"
				>
					<span class="size-1.5 shrink-0 rounded-full bg-action"></span>
					<span class="h-px flex-1 bg-action"></span>
				</span>
			{/if}
		</div>
	{/if}

	{#if reorder}
		<div
			aria-hidden="true"
			data-testid="placement-drag-ghost"
			class="pointer-events-none fixed z-[100] flex max-w-48 items-center gap-2 truncate rounded-sm border border-rule bg-panel px-2 py-1 text-sm font-medium text-ink shadow-lg"
			style:left={`${Math.max(8, Math.min(reorder.x + 14, window.innerWidth - 208))}px`}
			style:top={`${Math.max(8, Math.min(reorder.y + 14, window.innerHeight - 48))}px`}
		>
			<GripVerticalIcon aria-hidden="true" class="size-3.5 shrink-0 text-ink-3" />
			<span class="truncate">{reorderLabel}</span>
		</div>
	{/if}

	{#if placement.dragging && placement.dragPreview}
		<div
			aria-hidden="true"
			data-testid="placement-drag-ghost"
			class="pointer-events-none fixed z-[100] grid max-w-48 gap-0.5 rounded-sm border border-rule bg-panel px-2 py-1 text-sm font-medium text-ink shadow-lg"
			style:left={`${Math.max(8, Math.min(placement.dragPreview.x + 14, window.innerWidth - 208))}px`}
			style:top={`${Math.max(8, Math.min(placement.dragPreview.y + 14, window.innerHeight - 48))}px`}
		>
			<span class="flex items-center gap-2">
				<GripVerticalIcon aria-hidden="true" class="size-3.5 shrink-0 text-ink-3" />
				<span class="truncate">{placement.sourceLeafLabel}</span>
			</span>
			{#if placement.refusal}
				<span
					data-testid="placement-refusal"
					class="flex items-start gap-1 text-xs leading-snug font-normal text-state-error"
				>
					<BanIcon aria-hidden="true" class="mt-0.5 size-3 shrink-0" />
					<span>{placement.refusal.reason}</span>
				</span>
			{/if}
		</div>
	{/if}

	{#if !attributes.length}
		<p class="px-2 py-1.5 text-sm text-ink-3">{m.configuration_no_attributes()}</p>
	{/if}
</div>

<p class="sr-only" role="status" aria-live="polite">
	<span data-testid="attribute-move-announcement">{outline.announcement}</span>
	<span>{placement.announcement}</span>
	<span data-testid="answer-reorder-announcement">{answerReorder.announcement}</span>
</p>

<MergeConfirmDialog
	open={pendingMerge !== null}
	foldingText={pendingMerge?.foldingText ?? ''}
	survivorText={pendingSurvivorText}
	onConfirm={() => {
		if (pendingMerge) {
			onMergeOption(pendingMerge.attributeId, pendingMerge.foldedId, pendingMerge.survivorId);
		}
		pendingMerge = null;
	}}
	onCancel={() => (pendingMerge = null)}
/>
