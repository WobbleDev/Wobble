<script lang="ts">
	/**
	 * The permanent record panel: a glass rail beside the Workers table. It owns
	 * no record state — the selected Worker is chosen by the table, so a deleted,
	 * filtered-out or re-scoped Worker simply stops being passed in and the panel
	 * goes back to its empty line.
	 */
	import { untrack } from 'svelte';
	import { mergeProps } from 'bits-ui';
	import XIcon from '@lucide/svelte/icons/x';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import * as Sheet from '#lib/components/ui/sheet/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import IconTip from '#lib/shared/icon-tip.svelte';
	import type {
		Agitation,
		Language,
		Worker,
		WorkerAttributeValue,
		WorkerAttributeValues,
		WorkerNote,
		WorkerNoteEdit,
		WorkerNoteInput,
		WorkerTextField
	} from '#lib/domain-vocabulary.ts';
	import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { emptyValue } from '#lib/domain-vocabulary.ts';
	import RecordPanelHeader from './record-panel-header.svelte';
	import RecordPanelContact from './record-panel-contact.svelte';
	import RecordPanelAttributes from './record-panel-attributes.svelte';
	import RecordPanelLanguages from './record-panel-languages.svelte';
	import RecordPanelNotes from './record-panel-notes.svelte';
	import RecordPanelRelationships from './record-panel-relationships.svelte';
	import RecordPanelAgitations from './record-panel-agitations.svelte';
	import RecordPanelDelete from './record-panel-delete.svelte';
	import RecordPanelField from './record-panel-field.svelte';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import { deleteWorkerDraft, saveWorkerDraft } from '#lib/client/workers-api.ts';
	import { relativeTime } from '#lib/shared/format.ts';
	import { buildPanelDraft, hasUnsavedInput } from './panel-draft.ts';
	import { panelMode } from './panel-mode.ts';
	import { PanelDraftState, setPanelDraft } from './panel-draft-state.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { selectedCount } from '../copy.ts';

	type CohortNav = {
		position: number | null;
		total: number;
		hasPrevious: boolean;
		hasNext: boolean;
		/** The open Worker is not among the rows the filters show. */
		outsideFilters: boolean;
		/** Every Worker of the list is gone. */
		empty: boolean;
		onPrevious: () => void;
		onNext: () => void;
		onReturn: () => void;
	};

	type Props = {
		/** The selected Worker, or null when nothing is selected. */
		worker: Worker | null;
		/** Rows checked for a bulk edit; while any are, the panel summarises them. */
		checkedCount?: number;
		workers: Worker[];
		attributes: readonly WorkerAttributeDefinition[];
		agitations: readonly Agitation[];
		/** The Worksite's Languages, to pick a Worker's from. */
		languages?: readonly Language[];
		/** Writes the Worker's whole Language list. */
		onUpdateLanguages?: (workerId: string, languageIds: string[]) => Promise<void>;
		/** Begins a new Worker after saving what is open here. */
		onAddAnother?: () => void;
		/** Opens the Worker on the Mapping. */
		onShowOnMapping?: (workerId: string) => void;
		/** The list the record was opened from: Previous and Next, and the way back. */
		cohort?: CohortNav | null;
		/** Selects another Worker (a Relationship chip was clicked). */
		onSelectWorker?: (workerId: string) => void;
		/** Writes one of the Worker's free-text fields; the core validates it. */
		onUpdateField: (workerId: string, field: WorkerTextField, value: string) => Promise<void>;
		/** Writes the Worker's Assessment from the panel header. */
		onUpdateAssessment: (workerId: string, assessment: AssessmentOption) => Promise<void>;
		/** Writes one Attribute's answer(s) from the record panel. */
		onUpdateAttribute: (
			workerId: string,
			attributeId: string,
			value: WorkerAttributeValue
		) => Promise<void>;
		/** Adds a Note and answers the stored record. */
		onAddNote: (workerId: string, note: WorkerNoteInput) => Promise<Worker>;
		/** Takes one Note off the Worker by id. */
		onDeleteNote: (workerId: string, noteId: string) => Promise<void>;
		/** Deletes the Worker and their Relationships. */
		onDeleteWorker: (workerId: string) => Promise<void>;
		onEditNote: (workerId: string, edit: WorkerNoteEdit) => Promise<void>;
		/** Puts a deleted Note back exactly as it was, which is what its Undo sends. */
		onRestoreNote: (workerId: string, note: WorkerNote) => Promise<void>;
		/** Adds one Relationship pair. */
		onAddRelationship: (workerId: string, otherWorkerId: string) => Promise<void>;
		/** Removes one Relationship pair. */
		onRemoveRelationship: (workerId: string, otherWorkerId: string) => Promise<void>;
		/** Links one Agitation to a Worker. */
		onAssignAgitation: (workerId: string, agitationId: string) => Promise<void>;
		/** Unlinks one Agitation from a Worker. */
		onUnassignAgitation: (workerId: string, agitationId: string) => Promise<void>;
		/** Creates a worksite Agitation or returns the existing text match. */
		onCreateAgitation: (text: string) => Promise<Agitation>;
		/** Reloads the Workers table once a panel write has landed. */
		onRefresh: () => Promise<void>;
		onEditSaved?: (report: DataTableEditReport) => void;
		/** A delete is starting: the table records the row so focus can land on its replacement. */
		onBeforeDelete?: (workerId: string) => void;
		/** A delete landed: the table puts focus back where the record was. */
		onAfterDelete?: () => void;
		/** New Worker in progress: the Name input and the Attributes to create with. */
		creating?: {
			onCreate: (name: string, attributes: WorkerAttributeValues) => Promise<boolean>;
			onCancel: () => void;
		} | null;
		/** `rail` is the permanent desktop aside; `sheet` the same record from the right edge below it. */
		presentation?: 'rail' | 'sheet';
		/** Sheet only: open it on the "N Selected" summary, with no Worker. */
		summaryOpen?: boolean;
		/** The sheet's close: the owner clears the selection. */
		onClose?: () => void;
	};

	let {
		worker: liveWorker,
		checkedCount = 0,
		workers,
		attributes,
		agitations,
		languages = [],
		onUpdateLanguages,
		onAddAnother,
		onShowOnMapping,
		onSelectWorker,
		cohort = null,
		onUpdateField,
		onUpdateAssessment,
		onUpdateAttribute,
		onAddNote,
		onDeleteNote,
		onDeleteWorker,
		onEditNote,
		onRestoreNote,
		onAddRelationship,
		onRemoveRelationship,
		onAssignAgitation,
		onUnassignAgitation,
		onCreateAgitation,
		onRefresh,
		onEditSaved,
		onBeforeDelete,
		onAfterDelete,
		creating = null,
		presentation = 'rail',
		summaryOpen = false,
		onClose
	}: Props = $props();

	/**
	 * The sheet keeps showing the last Worker while it slides shut, so closing never
	 * flashes the empty hint; the rail has no exit and shows the live Worker only.
	 */
	let exiting = $state<Worker | null>(null);
	$effect(() => {
		if (liveWorker) {
			exiting = liveWorker;
			return;
		}
		if (creating) return;
		const timer = setTimeout(() => (exiting = null), 400);
		return () => clearTimeout(timer);
	});
	const worker = $derived(liveWorker ?? (presentation === 'sheet' ? exiting : null));

	const panelDraft = setPanelDraft(new PanelDraftState());

	/** New Worker's Attribute choices, before the record exists to write them to. */
	let createAttributes = $state<WorkerAttributeValues>({});
	$effect(() => {
		if (!creating) createAttributes = {};
	});

	/** The placeholder record the New Worker Attribute rows read and update. */
	const createWorker = $derived<Worker>({
		id: 'new',
		name: '',
		email: '',
		phone: '',
		assessment: 'Unassessed',
		attributes: Object.fromEntries(
			attributes.map((attribute) => [
				attribute.id,
				createAttributes[attribute.id] ?? emptyValue(attribute.kind)
			])
		),
		agitations: [],
		languages: [],
		relationships: [],
		notes: []
	});

	function onCreateWithAttributes(name: string): Promise<boolean> {
		if (!creating) return Promise.resolve(false);
		const values = Object.fromEntries(
			attributes.map((attribute) => [
				attribute.id,
				createAttributes[attribute.id] ?? emptyValue(attribute.kind)
			])
		);
		return creating.onCreate(name, values);
	}
	/** Bumped by Discard them, so the sections remount with their editors closed. */
	let draftRevision = $state(0);
	/** Runs the armed draft save at once, so a hide or unload does not lose it. */
	let pendingSave: (() => void) | null = null;

	// Each newly selected Worker: the record shows at once, and its stored draft is
	// read alongside. The reset runs before the render (pre), so the new record never
	// mounts with the previous Worker's open editors. Keyed on the id, so a refresh of
	// the same Worker after a write does not reload.
	const selectedId = $derived(worker?.id ?? null);
	$effect.pre(() => {
		const id = selectedId;
		untrack(() => {
			// Moving off a Worker writes its pending draft before its editors unmount, so
			// a half-typed field is still there when the organizer comes back.
			pendingSave?.();
			void panelDraft.load(id === null ? null : worker, attributes);
		});
	});

	// About a second after the last keystroke, store what the open editors hold.
	// With nothing left unsaved, a draft stored earlier is deleted at once.
	$effect(() => {
		// A re-run replaces the pending save; only leaving the page keeps it (see below).
		pendingSave = null;
		if (!worker || !panelDraft.ready || panelDraft.workerId !== worker.id) return;
		const id = worker.id;
		const open = $state.snapshot(panelDraft.open);
		if (!hasUnsavedInput(worker, open)) {
			panelDraft.status = 'idle';
			if (panelDraft.stored) {
				panelDraft.stored = false;
				untrack(() => (panelDraft.restoredAt = null));
				void deleteWorkerDraft(id);
			}
			return;
		}
		const payload = buildPanelDraft(worker, attributes, open);
		panelDraft.status = 'unsaved';
		const save = () => {
			clearTimeout(timer);
			pendingSave = null;
			panelDraft.stored = true;
			panelDraft.status = 'stored';
			void saveWorkerDraft(id, payload);
		};
		const timer = setTimeout(save, 1000);
		pendingSave = save;
		return () => clearTimeout(timer);
	});

	// Leaving the Workers page (nav rail, Worksite switch) unmounts the panel inside the
	// autosave window; the pending draft is written then, not dropped with the timer.
	$effect(() => () => pendingSave?.());

	// Hiding or unloading the page stores a pending draft immediately (best effort).
	$effect(() => {
		const flush = () => pendingSave?.();
		const onVisibility = () => {
			if (document.visibilityState === 'hidden') flush();
		};
		window.addEventListener('pagehide', flush);
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			window.removeEventListener('pagehide', flush);
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});

	async function discardDraft() {
		await panelDraft.discard();
		draftRevision += 1;
	}

	/**
	 * Binds a write to one Worker by value. Each editor snapshots the callback it
	 * was handed when its edit runs, so its Undo still names that Worker after the
	 * selection has moved on (ticket 25).
	 */
	function fieldLabel(field: WorkerTextField): string {
		if (field === 'name') return m.workers_field_name();
		return field === 'email' ? m.workers_field_email() : m.workers_field_phone();
	}

	function forWorker<A extends unknown[], R>(
		workerId: string,
		write: (workerId: string, ...args: A) => R
	): (...args: A) => R {
		return (...args) => write(workerId, ...args);
	}
</script>

{#snippet record(actions?: import('svelte').Snippet)}
	{#if creating}
		<header
			class="flex shrink-0 items-start justify-between gap-2 border-b border-rule px-4 pt-4 pb-3"
		>
			<div class="grid min-w-0 flex-1 gap-1">
				<RecordPanelField
					title
					label={m.workers_field_name()}
					fieldKind="name"
					editLabel={m.workers_edit_name()}
					editValueLabel={(value) => m.workers_edit_name_value({ value })}
					value=""
					placeholder={m.workers_add_name()}
					workerName={m.workers_unnamed_worker()}
					onSave={() => Promise.resolve()}
					refresh={onRefresh}
					onCreate={onCreateWithAttributes}
					onCancelCreate={creating.onCancel}
				/>
			</div>
			<div class="flex shrink-0 items-center gap-1">{@render actions?.()}</div>
		</header>
		<p class="px-4 pt-4 text-sm text-ink-3">{m.workers_panel_creating_hint()}</p>
		<div data-scrollbar-stable class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
			<RecordPanelAttributes
				worker={createWorker}
				{attributes}
				headingId="record-create-attributes"
				mode="pending"
				onPendingChange={(attributeId, value) => {
					createAttributes = { ...createAttributes, [attributeId]: value };
				}}
			/>
		</div>
	{:else if panelMode(checkedCount, worker !== null) === 'summary'}
		<div class="flex flex-1 items-center justify-center p-8 text-center">
			<p class="text-sm font-medium" data-testid="panel-selection-summary">
				<span class="num">{selectedCount(checkedCount)}</span>
			</p>
		</div>
		{#if presentation === 'sheet'}
			<div class="absolute top-2 right-2">{@render actions?.()}</div>
		{/if}
	{:else if worker}
		{#key `${worker.id}:${draftRevision}:${panelDraft.restoreRevision}`}
			<RecordPanelHeader
				{worker}
				{onUpdateField}
				{onUpdateAssessment}
				refresh={onRefresh}
				onSaved={onEditSaved}
				{actions}
			/>
			{#if cohort && (cohort.total > 0 || cohort.outsideFilters)}
				<nav
					aria-label={m.workers_cohort_nav()}
					class="flex shrink-0 items-center gap-2 border-b border-rule px-4 py-1.5 text-sm"
				>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						disabled={!cohort.hasPrevious}
						onclick={cohort.onPrevious}
					>
						<ChevronLeftIcon />
						{m.workers_cohort_previous()}
					</Button>
					<span class="num min-w-0 flex-1 text-center text-ink-2">
						{#if cohort.position !== null}
							{m.workers_cohort_position({ position: cohort.position, total: cohort.total })}
						{/if}
					</span>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						disabled={!cohort.hasNext}
						onclick={cohort.onNext}
					>
						{m.workers_cohort_next()}
						<ChevronRightIcon />
					</Button>
				</nav>
				{#if cohort.outsideFilters}
					<p
						data-testid="outside-filters"
						role="status"
						class="mx-4 mt-3 flex items-center justify-between gap-2 rounded-control border border-rule bg-inset p-2 text-sm"
					>
						<span>{m.workers_cohort_outside_filters()}</span>
						<Button type="button" variant="ghost" size="xs" onclick={cohort.onReturn}>
							{m.workers_cohort_return()}
						</Button>
					</p>
				{/if}
			{/if}
			{#if panelDraft.restoredAt}
				<div
					data-testid="restored-draft"
					class="mx-4 mt-3 rounded-control border border-rule bg-inset p-2 text-sm"
					role="status"
				>
					<p>
						{m.workers_draft_restored({ time: relativeTime(panelDraft.restoredAt) })}
						<Button
							type="button"
							variant="ghost"
							size="xs"
							class="-my-0.5 font-medium"
							onclick={() => void discardDraft()}
						>
							{m.workers_draft_discard()}
						</Button>
					</p>
					{#if panelDraft.baseChanged}
						<p class="text-ink-2">{m.workers_draft_base_changed()}</p>
						{#if panelDraft.differences.length}
							<ul class="mt-1 grid gap-0.5 text-ink-2" data-testid="draft-comparison">
								{#each panelDraft.differences as difference (difference.field)}
									<li>
										{m.workers_draft_compare({
											field: fieldLabel(difference.field),
											saved: difference.saved || m.workers_draft_compare_empty(),
											draft: difference.draft || m.workers_draft_compare_empty()
										})}
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				</div>
			{/if}
			{#if panelDraft.status !== 'idle'}
				<p data-testid="draft-status" role="status" class="mx-4 mt-2 text-xs text-ink-3">
					{panelDraft.status === 'unsaved'
						? m.workers_draft_state_unsaved()
						: m.workers_draft_state_stored()}
				</p>
			{/if}
			<div
				data-scrollbar-stable
				class="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-6 overflow-y-auto mask-[linear-gradient(to_bottom,transparent,black_0.75rem)] px-4 py-6"
			>
				<RecordPanelContact
					{worker}
					headingId="record-contact"
					{onUpdateField}
					refresh={onRefresh}
					onSaved={onEditSaved}
				/>
				<RecordPanelAttributes
					{worker}
					{attributes}
					headingId="record-attributes"
					refresh={onRefresh}
					onSaved={onEditSaved}
					onUpdate={(attributeId, value) => onUpdateAttribute(worker.id, attributeId, value)}
				/>
				{#if onUpdateLanguages}
					<RecordPanelLanguages
						{worker}
						{languages}
						headingId="record-languages"
						onUpdate={forWorker(worker.id, onUpdateLanguages)}
						refresh={onRefresh}
						onSaved={onEditSaved}
					/>
				{/if}
				<RecordPanelNotes
					{worker}
					headingId="record-notes"
					onAddNote={forWorker(worker.id, onAddNote)}
					onDeleteNote={forWorker(worker.id, onDeleteNote)}
					onEditNote={forWorker(worker.id, onEditNote)}
					onRestoreNote={forWorker(worker.id, onRestoreNote)}
					refresh={onRefresh}
					onSaved={onEditSaved}
				/>
				<RecordPanelRelationships
					{worker}
					{workers}
					{attributes}
					headingId="record-relationships"
					{onSelectWorker}
					{onShowOnMapping}
					{onAddRelationship}
					{onRemoveRelationship}
					refresh={onRefresh}
					onSaved={onEditSaved}
				/>
				<RecordPanelAgitations
					{worker}
					{agitations}
					headingId="record-agitations"
					onAssignAgitation={forWorker(worker.id, onAssignAgitation)}
					onUnassignAgitation={forWorker(worker.id, onUnassignAgitation)}
					{onCreateAgitation}
					refresh={onRefresh}
					onSaved={onEditSaved}
				/>
				{#if onAddAnother}
					<Button
						type="button"
						variant="outline"
						size="sm"
						class="min-h-tap justify-self-start lg:min-h-8"
						onclick={onAddAnother}
					>
						{m.workers_add_another()}
					</Button>
				{/if}
				<RecordPanelDelete
					{worker}
					onDelete={onDeleteWorker}
					refresh={onRefresh}
					onReport={(report) => onEditSaved?.(report)}
					{onBeforeDelete}
					{onAfterDelete}
				/>
			</div>
		{/key}
	{:else}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			{#if cohort?.empty}
				<p data-testid="empty-cohort" role="status" class="max-w-56 text-sm font-medium">
					{m.workers_cohort_empty()}
				</p>
				<Button type="button" variant="outline" size="sm" onclick={cohort.onReturn}>
					{m.workers_cohort_return()}
				</Button>
			{:else}
				<p class="max-w-56 text-sm text-muted-foreground">{m.workers_panel_empty()}</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet closeButton()}
	<Sheet.Close>
		{#snippet child({ props: closeProps })}
			<IconTip label={m.common_close()}>
				{#snippet child({ props })}
					<Button
						variant="ghost"
						size="icon"
						class="min-h-tap min-w-tap"
						{...mergeProps(closeProps, props)}
					>
						<XIcon />
						<span class="sr-only">{m.common_close()}</span>
					</Button>
				{/snippet}
			</IconTip>
		{/snippet}
	</Sheet.Close>
{/snippet}

{#snippet railCloseButton()}
	<IconTip label={m.common_close()}>
		{#snippet child({ props })}
			<Button
				variant="ghost"
				size="icon"
				class="min-h-tap min-w-tap"
				{...props}
				onclick={() => onClose?.()}
			>
				<XIcon />
				<span class="sr-only">{m.common_close()}</span>
			</Button>
		{/snippet}
	</IconTip>
{/snippet}

{#if presentation === 'sheet'}
	<Sheet.Root
		open={liveWorker !== null || creating !== null || summaryOpen}
		onOpenChange={(open) => {
			if (!open) onClose?.();
		}}
	>
		<Sheet.Content
			side="right"
			showCloseButton={false}
			data-testid="record-panel"
			aria-label={creating
				? m.workers_panel_creating_details()
				: worker
					? m.workers_panel_details_named({ name: worker.name })
					: m.workers_panel_details()}
			aria-describedby={undefined}
			class="data-[side=right]:w-[min(22rem,100vw)] data-[side=right]:sm:max-w-none"
		>
			{@render record(closeButton)}
		</Sheet.Content>
	</Sheet.Root>
{:else}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<aside
		onkeydown={(event) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			if (
				event.target instanceof Element &&
				event.target.closest('input, textarea, select, [role="combobox"], [contenteditable="true"]')
			)
				return;
			event.preventDefault();
			onClose?.();
		}}
		id={worker ? `worker-${worker.id}-details` : undefined}
		data-testid="record-panel"
		aria-label={creating
			? m.workers_panel_creating_details()
			: worker
				? m.workers_panel_details_named({ name: worker.name })
				: m.workers_panel_details()}
		data-material="glass"
		data-rail="true"
		class="flex min-h-0 w-72 shrink-0 flex-col overflow-hidden rounded-surface"
	>
		{@render record(onClose ? railCloseButton : undefined)}
	</aside>
{/if}
