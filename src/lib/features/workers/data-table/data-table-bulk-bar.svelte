<script lang="ts">
	/**
	 * The Workers table's bulk toolbar: the one surface that acts on a whole selection.
	 *
	 * It is pinned under the table and only exists while the
	 * selection is non-empty. Every action commits through the same
	 * `#lib/client/workers-api.ts` endpoints the Workers table cells call, one call per
	 * selected Worker, and reports the batch once so a single Undo puts all of
	 * it back.
	 */
	import { refreshWorkers } from '#lib/features/workers/refresh-workers.ts';
	import { getEditModel } from '#lib/features/workers/edit-model.svelte.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import SwatchDot from '#lib/shared/swatch-dot.svelte';
	import { assessmentColorFor } from '#lib/shared/assessment.ts';
	import { storesList } from '#lib/shared/select-mode.ts';
	import { normalizeForMatch } from '#lib/shared/text.ts';
	import {
		assessmentOptions,
		type AssessmentOption,
		type Language,
		type Worker
	} from '#lib/domain-vocabulary.ts';
	import {
		answerChoices,
		assessmentChoices,
		heldCategoryAnswerId,
		heldTagAnswerIds,
		holdsAnswer
	} from '../answers.ts';
	import { bulkCopy, selectedCount } from '../copy.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import {
		deleteWorker as deleteWorkerRequest,
		updateWorkerAssessment,
		updateWorkerAttribute,
		updateWorkerLanguages
	} from '#lib/client/workers-api.ts';
	import MergeDialog from '../merge/merge-dialog.svelte';
	import DeleteConfirmDialog from './delete-confirm-dialog.svelte';
	import MenuSearch from './menu-search.svelte';
	import { createDataTableActionState } from './data-table-action-state.svelte.ts';
	import { bulkValueState, createBulkActions } from './data-table-bulk-actions.ts';
	import type { DataTableEditReport } from './data-table-features.ts';
	import type { WorkersSelection } from './data-table-selection.svelte.ts';

	type Props = {
		selection: WorkersSelection;
		workers: readonly Worker[];
		attributes: readonly WorkerAttributeDefinition[];
		languages: readonly Language[];
		reportEdit: (report: DataTableEditReport) => void;
		/** Below lg the count is a button that opens the record sheet in summary mode. */
		onOpenSummary: () => void;
		/** The bar's own element, measured by the table so the fixed status line clears it. */
		barRef?: HTMLDivElement | null;
		/** A delete is starting: the table records the row so focus can land on its replacement. */
		onBeforeDelete?: (workerId: string) => void;
		/** A delete landed: the table puts focus back in the grid instead of on `<body>`. */
		onAfterDelete?: () => void;
		/** The bar is emptying itself (Clear): the table puts focus back in the grid. */
		onFocusReturn?: () => void;
	};

	let {
		selection,
		workers,
		attributes,
		languages,
		reportEdit,
		onOpenSummary,
		barRef = $bindable(null),
		onBeforeDelete,
		onAfterDelete,
		onFocusReturn
	}: Props = $props();

	/** The complete, count-aware copy this bar's batches report with. */
	const copy = bulkCopy();

	const actions = createBulkActions(
		{
			updateAssessment: updateWorkerAssessment,
			updateLanguages: updateWorkerLanguages,
			updateAttribute: updateWorkerAttribute,
			deleteWorker: deleteWorkerRequest,
			refresh: refreshWorkers
		},
		copy
	);

	const actionState = createDataTableActionState();

	// The Edit and Actions menus hold the body's pointer events while open; a
	// multi menu stays open across toggles (closeOnSelect is off), so a menu
	// left open after its batch lands reads as the whole app freezing in place.
	let editMenuOpen = $state(false);
	let actionsMenuOpen = $state(false);

	/** The view's edit model, so a batch saves open panel drafts before it starts. */
	const editModel = getEditModel();

	/** The selected Workers in Workers table order; the appliers close over this snapshot. */
	const selected = $derived(workers.filter((worker) => selection.isSelected(worker.id)));

	/** The two Workers the open merge dialog was started for. */
	let mergeTargets = $state<readonly [Worker, Worker] | null>(null);

	async function openMerge() {
		if (actionState.pending || selected.length !== 2) return;
		// An open editor's draft is saved first: a draft on either Worker blocks the merge.
		if (!(await editModel.flushDrafts())) return;
		const [first, second] = selected;
		if (selected.length === 2 && first && second) {
			actionsMenuOpen = false;
			mergeTargets = [first, second];
		}
	}

	let deleteOpen = $state(false);
	/**
	 * The batch the open Delete dialog describes. Frozen when it opens: the
	 * selection empties as the deletion lands, and a closing dialog must not
	 * relabel itself "Delete 0 workers?" on the way out.
	 */
	let deleteCount = $state(0);
	/** How many of that batch the filters hide; frozen with the count, for the same reason. */
	let deleteOutside = $state(0);
	/** What the Attributes chooser is narrowed to; choosing a field reveals its batch actions. */
	let attributeSearch = $state('');

	/** What Edit languages is narrowed to; the field only exists for a long list. */
	let languageSearch = $state('');
	/** Past this many Languages the menu is worth searching; shorter lists stay short. */
	const LANGUAGE_SEARCH_THRESHOLD = 8;
	const matchingLanguages = $derived(
		languages.filter((language) =>
			language.name.toLowerCase().includes(normalizeForMatch(languageSearch))
		)
	);

	function matchesSearch(name: string): boolean {
		return name.toLowerCase().includes(normalizeForMatch(attributeSearch));
	}

	const matchingAttributes = $derived(
		attributes.filter((attribute) => matchesSearch(attribute.name))
	);

	/** The two fixed fields the Edit menu offers beside the Attributes. */
	const fieldEntries = [
		{
			id: 'assessment',
			name: m.workers_column_assessment(),
			label: m.workers_bulk_set_assessment()
		},
		{
			id: 'languages',
			name: m.workers_column_languages(),
			label: m.workers_bulk_edit_languages()
		}
	];

	/** Runs one batch and reports it once it has landed. */
	async function commit(
		fallback: string,
		build: () => Promise<DataTableEditReport>
	): Promise<boolean> {
		if (actionState.pending || selected.length === 0) return false;
		// What is being typed in the panel is saved first: a bulk edit must not
		// reload the Workers table out from under an open editor. A refused draft stops
		// the batch, exactly as it stops a selection change.
		if (!(await editModel.flushDrafts())) return false;

		let report: DataTableEditReport | null = null;
		const saved = await actionState.run(async () => {
			report = await build();
		}, fallback);

		const built = report as DataTableEditReport | null;
		if (saved && built) {
			reportEdit(built);
			// The batch landed: hand the page back. A refused batch keeps the menu
			// open so the choice can be tried again.
			editMenuOpen = false;
			actionsMenuOpen = false;
		}
		return Boolean(saved && built);
	}

	function chooseAssessment(assessment: AssessmentOption) {
		void commit(copy.assessmentFailed(selected.length), () =>
			actions.setAssessment(selected, assessment)
		);
	}

	function languageState(language: Language) {
		return bulkValueState(selected, (worker) => worker.languages.includes(language.id));
	}

	/** Whether every, some or none of the selection holds one answer, by its id. */
	function tagState(attribute: WorkerAttributeDefinition, answerId: string) {
		return bulkValueState(selected, (worker) => holdsAnswer(worker, attribute, answerId));
	}

	function toggleLanguage(language: Language, checked: boolean) {
		void commit(copy.languagesFailed(selected.length), () =>
			checked ? actions.addLanguage(selected, language) : actions.removeLanguage(selected, language)
		);
	}

	/** A sentinel no RadioItem carries, so a mixed Category checks none of them. */
	const MIXED = '__mixed__';

	/**
	 * The answer the selection shares. `mixed` is its own state: None is checked
	 * only when every selected Worker genuinely has no value for this Category.
	 */
	function categoryState(attribute: WorkerAttributeDefinition): { value: string; mixed: boolean } {
		const [first, ...rest] = selected;
		if (!first) return { value: '', mixed: false };

		const value = heldCategoryAnswerId(first, attribute);
		const shared = rest.every((worker) => heldCategoryAnswerId(worker, attribute) === value);
		return shared ? { value, mixed: false } : { value: MIXED, mixed: true };
	}

	function setCategoryValue(attribute: WorkerAttributeDefinition, value: string) {
		if (value === MIXED) return;

		void commit(copy.setFailed(attribute.name, selected.length), () =>
			actions.setCategoryValue(selected, attribute, value)
		);
	}

	function toggleTag(attribute: WorkerAttributeDefinition, answerId: string, checked: boolean) {
		void commit(copy.changeFailed(attribute.name, selected.length), () =>
			checked
				? actions.addTag(selected, attribute, answerId)
				: actions.removeTag(selected, attribute, answerId)
		);
	}

	/** Takes every value off the whole selection; Undo puts each Worker's own back. */
	function clearTags(attribute: WorkerAttributeDefinition) {
		void commit(copy.changeFailed(attribute.name, selected.length), () =>
			actions.clearTags(selected, attribute)
		);
	}

	function openDelete() {
		actionState.clearError();
		deleteCount = selected.length;
		deleteOutside = selection.outsideFilterCount;
		deleteOpen = true;
	}

	async function confirmDelete() {
		// Snapshot the batch: the selection empties as the deletion lands.
		const targets = selected;
		// The row is read now, while it is still in the table, so focus can follow the deletion.
		const first = targets[0]?.id;
		if (first) onBeforeDelete?.(first);
		// The dialog stays open while the batch is in flight, then hands the outcome back to
		// the bar, which surfaces it either way.
		const removed = await commit(copy.deleteFailed(deleteCount), () =>
			actions.deleteWorkers(targets)
		).finally(() => {
			deleteOpen = false;
		});
		// The bar may have emptied with the batch: put focus back in the grid rather than on body.
		if (removed) onAfterDelete?.();
	}
</script>

{#snippet assessmentItems()}
	{#each assessmentChoices(assessmentOptions) as choice (choice.value)}
		<DropdownMenu.Item
			disabled={actionState.pending}
			onSelect={() => chooseAssessment(choice.value as AssessmentOption)}
		>
			<span class="flex items-center gap-2">
				<SwatchDot color={assessmentColorFor(choice.value as AssessmentOption)} />
				{choice.label}
			</span>
		</DropdownMenu.Item>
	{/each}
{/snippet}

{#snippet languageItems()}
	{#if languages.length === 0}
		<div class="grid gap-0.5 px-2 py-1.5">
			<p class="text-sm text-muted-foreground">{m.workers_filter_nothing_set_up()}</p>
			<p class="text-sm text-muted-foreground">{m.workers_bulk_add_languages()}</p>
		</div>
	{:else}
		{#if languages.length > LANGUAGE_SEARCH_THRESHOLD}
			<MenuSearch label={m.workers_bulk_search_languages()} bind:value={languageSearch} />
		{/if}
		{#each matchingLanguages as language (language.id)}
			{@const state = languageState(language)}
			<DropdownMenu.CheckboxItem
				checked={state === 'all'}
				closeOnSelect={false}
				disabled={actionState.pending}
				onCheckedChange={() => toggleLanguage(language, state !== 'all')}
			>
				{language.name}{#if state === 'some'}<span class="text-ink-3">
						{m.workers_bulk_some()}</span
					>{/if}
			</DropdownMenu.CheckboxItem>
		{:else}
			<div class="grid gap-0.5 px-2 py-1.5">
				<p class="text-sm text-muted-foreground">
					{m.workers_bulk_no_languages_match({ query: languageSearch.trim() })}
				</p>
			</div>
		{/each}
	{/if}
{/snippet}

{#snippet attributeActions(attribute: (typeof attributes)[number])}
	{#if attribute.answers === undefined || attribute.answers.length === 0}
		<div class="grid gap-0.5 px-2 py-1.5">
			<p class="text-sm text-muted-foreground">{m.workers_filter_nothing_set_up()}</p>
			<p class="text-sm text-muted-foreground">
				{m.workers_bulk_add_field_in_configuration({ field: attribute.name })}
			</p>
		</div>
	{:else if !storesList(attribute)}
		{@const state = categoryState(attribute)}
		{#if state.mixed}
			<!-- A description, not a choice: nobody's answer is being reported as None. -->
			<DropdownMenu.Item disabled>{m.workers_bulk_mixed()}</DropdownMenu.Item>
			<DropdownMenu.Separator />
		{/if}
		<DropdownMenu.RadioGroup
			value={state.value}
			onValueChange={(value) => setCategoryValue(attribute, value)}
		>
			<DropdownMenu.RadioItem value="" disabled={actionState.pending}
				>{m.common_none()}</DropdownMenu.RadioItem
			>
			{#each answerChoices(attribute) as option (option.value)}
				<DropdownMenu.RadioItem value={option.value} disabled={actionState.pending}>
					{option.label}
				</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
		{#if state.mixed}
			<DropdownMenu.Separator />
			<DropdownMenu.Item
				disabled={actionState.pending}
				onSelect={() => setCategoryValue(attribute, '')}
			>
				{m.workers_bulk_clear_for_all()}
			</DropdownMenu.Item>
		{/if}
	{:else}
		{#each answerChoices(attribute) as option (option.value)}
			{@const state = tagState(attribute, option.value)}
			<DropdownMenu.CheckboxItem
				checked={state === 'all'}
				closeOnSelect={false}
				disabled={actionState.pending}
				onCheckedChange={() => toggleTag(attribute, option.value, state !== 'all')}
			>
				{option.label}{#if state === 'some'}<span class="text-ink-3">
						{m.workers_bulk_some()}</span
					>{/if}
			</DropdownMenu.CheckboxItem>
		{/each}
		{#if selected.some((worker) => heldTagAnswerIds(worker, attribute).length > 0)}
			<DropdownMenu.Separator />
			<DropdownMenu.Item disabled={actionState.pending} onSelect={() => clearTags(attribute)}>
				{m.workers_bulk_clear_for_all()}
			</DropdownMenu.Item>
		{/if}
	{/if}
{/snippet}

{#snippet attributeChooser(withFields: boolean)}
	{#if attributes.length === 0 && !withFields}
		<div class="grid gap-0.5 px-2 py-1.5">
			<p class="text-sm text-muted-foreground">{m.workers_filter_nothing_set_up()}</p>
			<p class="text-sm text-muted-foreground">{m.workers_bulk_add_attributes()}</p>
		</div>
	{:else}
		<MenuSearch label={m.workers_bulk_search_attributes()} bind:value={attributeSearch} />
		{#if withFields}
			<!-- Assessment and Languages are fields too, so the one Edit menu reaches every field. -->
			{#each fieldEntries.filter((entry) => matchesSearch(entry.name)) as entry (entry.id)}
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger>{entry.label}</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent collisionPadding={12} class="max-h-[50vh] overflow-y-auto">
						{#if entry.id === 'assessment'}
							{@render assessmentItems()}
						{:else}
							{@render languageItems()}
						{/if}
					</DropdownMenu.SubContent>
				</DropdownMenu.Sub>
			{/each}
		{/if}
		{#each matchingAttributes as attribute (attribute.id)}
			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger>
					{!storesList(attribute)
						? m.workers_bulk_set_field({ field: attribute.name })
						: m.workers_bulk_edit_field({ field: attribute.name })}
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent collisionPadding={12} class="max-h-[50vh] overflow-y-auto">
					{@render attributeActions(attribute)}
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>
		{:else}
			{#if !withFields || !fieldEntries.some((entry) => matchesSearch(entry.name))}
				<DropdownMenu.Group>
					<div class="grid gap-0.5 px-2 py-1.5">
						<p class="text-sm text-muted-foreground">
							{m.workers_bulk_no_attributes_match({ query: attributeSearch.trim() })}
						</p>
					</div>
				</DropdownMenu.Group>
			{/if}
		{/each}
	{/if}
{/snippet}

{#if selection.count > 0}
	<!-- Pinned under the table; at lg it lies over the hint line's fixed slot, so checking rows resizes nothing. -->
	<div
		bind:this={barRef}
		data-testid="bulk-bar"
		class="sticky bottom-0 z-30 flex shrink-0 flex-nowrap items-center justify-between gap-x-4 gap-y-2 border-t border-rule bg-inset px-3 py-2 max-lg:pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:absolute lg:inset-x-0 lg:bottom-0 lg:flex-wrap lg:px-4"
	>
		<div class="flex min-w-0 items-center gap-2 lg:flex-wrap">
			<p
				class="num min-w-0 truncate text-sm font-medium lg:overflow-visible lg:whitespace-normal"
				role="status"
				aria-live="polite"
			>
				<!-- Kept raw: the mobile count is a link-styled text button inside a sentence. -->
				<button
					type="button"
					class="min-h-tap rounded-item font-medium underline decoration-ink-3 underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none lg:hidden"
					onclick={onOpenSummary}
				>
					{selectedCount(selection.count)}
				</button><span class="max-lg:hidden">{selectedCount(selection.count)}</span
				>{#if selection.outsideFilterCount > 0}
					· {m.workers_outside_filters({ count: selection.outsideFilterCount })}{/if}
			</p>
			<Button
				variant="outline"
				size="sm"
				class="min-h-tap shrink-0 lg:min-h-8"
				aria-label={m.workers_clear_selection()}
				disabled={actionState.pending}
				onclick={() => {
					selection.clear();
					// The bar unmounts with the selection: focus goes back to the grid, not `<body>`.
					onFocusReturn?.();
				}}
			>
				<span class="lg:hidden">{m.workers_clear()}</span><span class="hidden lg:inline"
					>{m.workers_clear_selection()}</span
				>
			</Button>
		</div>

		<!-- Below the Shell tier the actions fold into one menu so the bar stays on one line. -->
		<DropdownMenu.Root bind:open={actionsMenuOpen}>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="sm" class="min-h-tap shrink-0 lg:hidden">
						{m.workers_bulk_actions()}
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" collisionPadding={12} class="w-56">
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger>{m.workers_bulk_set_assessment()}</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent collisionPadding={12}
						>{@render assessmentItems()}</DropdownMenu.SubContent
					>
				</DropdownMenu.Sub>
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger>{m.workers_bulk_edit_languages()}</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent collisionPadding={12}
						>{@render languageItems()}</DropdownMenu.SubContent
					>
				</DropdownMenu.Sub>
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger>{m.workers_bulk_attribute()}</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent collisionPadding={12} class="w-64"
						>{@render attributeChooser(false)}</DropdownMenu.SubContent
					>
				</DropdownMenu.Sub>
				{#if selected.length === 2}
					<DropdownMenu.Item disabled={actionState.pending} onSelect={() => void openMerge()}>
						{m.workers_merge_action()}
					</DropdownMenu.Item>
				{/if}
				<DropdownMenu.Separator />
				<DropdownMenu.Item
					variant="destructive"
					disabled={actionState.pending}
					onSelect={openDelete}
				>
					{m.workers_bulk_delete()}
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<div class="hidden flex-wrap items-center gap-2 lg:flex">
			<DropdownMenu.Root bind:open={editMenuOpen}>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="sm" class="min-h-tap lg:min-h-8">
							{m.workers_bulk_edit()}
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" collisionPadding={12} class="w-64">
					{@render attributeChooser(true)}
				</DropdownMenu.Content>
			</DropdownMenu.Root>

			{#if selected.length === 2}
				<Button
					variant="outline"
					size="sm"
					class="min-h-tap lg:min-h-8"
					disabled={actionState.pending}
					onclick={() => void openMerge()}
				>
					{m.workers_merge_action()}
				</Button>
			{/if}

			<Button
				variant="outline"
				size="sm"
				class="min-h-tap border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive lg:min-h-8"
				disabled={actionState.pending}
				onclick={openDelete}
			>
				{m.workers_bulk_delete()}
			</Button>
		</div>

		{#if actionState.errorMessage}
			<p class="basis-full text-xs text-destructive" role="alert">{actionState.errorMessage}</p>
		{/if}
	</div>
{/if}

<DeleteConfirmDialog
	bind:open={deleteOpen}
	subject={copy.count(deleteCount)}
	pending={actionState.pending}
	onConfirm={confirmDelete}
>
	{#if deleteOutside > 0}
		{m.workers_delete_outside({ count: deleteOutside })}
	{/if}
	{m.workers_delete_workers_body()}
</DeleteConfirmDialog>

{#if mergeTargets}
	<MergeDialog
		workers={mergeTargets}
		{attributes}
		onMerged={reportEdit}
		onClose={() => (mergeTargets = null)}
	/>
{/if}
