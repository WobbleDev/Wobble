<script lang="ts">
	/**
	 * The Workers table grid itself: the table, its filter bar, and the record panel (a rail on
	 * desktop, a sheet below it) opened from a row.
	 */
	import { tick, untrack } from 'svelte';
	import { fly } from 'svelte/transition';
	import { reducedMotion as motionIsReduced } from '#lib/shell/motion.svelte.ts';
	import { type ColumnDef, createTable, FlexRender } from '@tanstack/svelte-table';
	import { IsMobile } from '#lib/hooks/is-mobile.svelte.ts';
	import { cn } from '#lib/utils.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { columnStyle, pinClass, workersRowClass } from './columns.ts';
	import {
		features,
		type DataTableEditReport,
		type DataTableFeatures
	} from './data-table-features.ts';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { PersonPartition } from '#lib/shared/person-state.svelte.ts';
	import { cohortExhausted, cohortPosition } from './worker-cohort.ts';
	import { filterParamsKey } from './data-table-url-filters.svelte.ts';
	import DataTableRow from './data-table-row.svelte';
	import RecordPanel from '../record-panel/record-panel.svelte';
	import DataTableFilterBar from './data-table-filter-bar.svelte';
	import DataTableVirtualSpacer from './data-table-virtual-spacer.svelte';
	import DataTableBulkBar from './data-table-bulk-bar.svelte';
	import { createWorkersSelection } from './data-table-selection.svelte.ts';
	import { createWorkersColumnOrder } from './data-table-column-order.svelte.ts';
	import { createWorkersColumnFit } from './data-table-column-fit.svelte.ts';
	import { createWorkersUrlFilters } from './data-table-url-filters.svelte.ts';
	import { createWorkersKeyboard } from './data-table-keyboard.svelte.ts';
	import StatusLine from '#lib/features/workers/status-line.svelte';
	import { getEditModel } from '#lib/features/workers/edit-model.svelte.ts';
	import {
		createDataTableVirtualizer,
		type DataTableRenderItem
	} from './data-table-virtualizer.svelte.ts';
	import { nameColumnRem } from './workers-table-width.ts';
	import { createView, deleteView, listViews, updateView } from '#lib/client/views-api.ts';
	import { createSavedViews } from '#lib/features/saved-views/saved-views.svelte.ts';
	import SavedViewReviewDialog from '#lib/features/saved-views/saved-view-review-dialog.svelte';
	import {
		captureWorkersView,
		workersViewToTable
	} from '#lib/features/saved-views/workers-view-state.ts';
	import type {
		Agitation,
		AssessmentOption,
		Language,
		WorkerAttributeValue,
		WorkerAttributeValues,
		Worker,
		WorkerNote,
		WorkerNoteEdit,
		WorkerNoteInput,
		WorkerTextField
	} from '#lib/domain-vocabulary.ts';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { formatList } from '#lib/i18n/format.ts';

	type DataTableProps = {
		columns: ColumnDef<DataTableFeatures, Worker>[];
		data: Worker[];
		attributes: readonly WorkerAttributeDefinition[];
		agitations: readonly Agitation[];
		languages: readonly Language[];
		onUpdateAttribute: (
			workerId: string,
			attributeId: string,
			value: WorkerAttributeValue
		) => Promise<void>;
		onUpdateAssessment: (workerId: string, assessment: AssessmentOption) => Promise<void>;
		onDeleteWorker: (workerId: string) => Promise<void>;
		onUpdateLanguages: (workerId: string, languageIds: string[]) => Promise<void>;
		/** Writes one of the Worker's free-text fields from the record panel. */
		onUpdateField: (workerId: string, field: WorkerTextField, value: string) => Promise<void>;
		/** Adds a Note from the record panel, answering the stored record. */
		onAddNote: (workerId: string, note: WorkerNoteInput) => Promise<Worker>;
		/** Takes one Note off the Worker by id. */
		onDeleteNote: (workerId: string, noteId: string) => Promise<void>;
		onEditNote: (workerId: string, edit: WorkerNoteEdit) => Promise<void>;
		/** Puts a deleted Note back exactly as it was. */
		onRestoreNote: (workerId: string, note: WorkerNote) => Promise<void>;
		/** Adds one Relationship pair from the record panel. */
		onAddRelationship: (workerId: string, otherWorkerId: string) => Promise<void>;
		/** Removes one Relationship pair from the record panel. */
		onRemoveRelationship: (workerId: string, otherWorkerId: string) => Promise<void>;
		/** Links one Agitation to a Worker from the record panel. */
		onAssignAgitation: (workerId: string, agitationId: string) => Promise<void>;
		/** Unlinks one Agitation from a Worker from the record panel. */
		onUnassignAgitation: (workerId: string, agitationId: string) => Promise<void>;
		/** Creates a worksite Agitation or returns the existing text match. */
		onCreateAgitation: (text: string) => Promise<Agitation>;
		onRefresh: () => Promise<void>;
		/** Creates a Worker with the Attributes chosen in the New Worker panel. */
		onCreateWorker: (name: string, attributes: WorkerAttributeValues) => Promise<Worker>;
		initialFilters?: { id: string; value: unknown }[];
		/** The private person-specific partition of the active Worksite: the open record lives here. */
		person: PersonPartition;
	};

	let {
		data,
		columns,
		attributes,
		agitations,
		languages,
		onUpdateAttribute,
		onUpdateAssessment,
		onDeleteWorker,
		onUpdateLanguages,
		onUpdateField,
		onAddNote,
		onDeleteNote,
		onEditNote,
		onRestoreNote,
		onAddRelationship,
		onRemoveRelationship,
		onAssignAgitation,
		onUnassignAgitation,
		onCreateAgitation,
		onRefresh,
		onCreateWorker,
		initialFilters = [],
		person
	}: DataTableProps = $props();
	let scrollViewport = $state<HTMLElement | null>(null);
	/** The bulk bar's own element, measured so the fixed status line can sit above it. */
	let bulkBarElement = $state<HTMLDivElement | null>(null);
	/** The bulk bar's measured height in px; 0 while no rows are checked. */
	let bulkBarHeight = $state(0);
	/** The view's one status line; this table reports into it like every edit path. */
	const editModel = getEditModel();

	function reportEdit(report: DataTableEditReport) {
		editModel.report(report);
	}

	// The header checkbox governs the rows the filters match, so the selection
	// follows the filtered row model — not the data prop, and not the mounted rows.
	const selection = createWorkersSelection(
		() => data,
		() => editModel.flushDrafts()
	);

	const table = createTable({
		features,
		enableSortingRemoval: false,
		get data() {
			return data;
		},
		get columns() {
			return columns;
		},
		get meta() {
			return {
				updateAttribute: onUpdateAttribute,
				updateAssessment: onUpdateAssessment,
				updateLanguages: onUpdateLanguages,
				reportEdit,
				reportFailure: (message: string) => editModel.fail(message),
				refresh: onRefresh,
				selection
			};
		},
		// Rows keyed by Worker identity, so a lookup by id points at the same
		// Worker through a sort, a filter and a reload.
		getRowId: (row) => row.id,
		// Initial state on purpose: later navigation re-mounts this surface.
		initialState: {
			sorting: [{ id: 'name', desc: false }],
			// The Agitation facet is a filter, not a column: it never shows in the grid.
			columnVisibility: { agitations: false },
			columnFilters: untrack(() =>
				initialFilters.map((filter) => ({ id: filter.id, value: filter.value }))
			)
		}
	});

	// Every filter change re-scopes the header checkbox to the new match set.
	$effect(() => {
		selection.setMatchingIds(table.getFilteredRowModel().rows.map((row) => row.original.id));
	});

	$effect(() => {
		selection.setVisibleIds(rows.map((row) => row.original.id));
	});

	// The status line is fixed to the viewport, so it reads the bulk bar's height from
	// here: measured rather than assumed, because a wrapped bar changes height.
	$effect(() => {
		const element = bulkBarElement;
		if (!element) {
			bulkBarHeight = 0;
			return;
		}
		const measure = () => (bulkBarHeight = element.offsetHeight);
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		measure();
		return () => observer.disconnect();
	});

	/**
	 * The grid's active cell: a (Worker id, column id) pair held beside the
	 * table like the selection, so sort, filter and virtualization cannot drop it.
	 * Null until a cell is used; the first visible row's Name cell is active then.
	 */
	let activeCell = $state<{ workerId: string; columnId: string } | null>(null);
	/** The cell that takes focus on Tab: the pair, or the first visible row if its Worker is filtered out. */
	const effectiveActive = $derived.by(() => {
		const first = rows[0];
		if (!first) return null;
		const columnIds = table.getVisibleLeafColumns().map((column) => column.id);
		const wanted = activeCell?.columnId ?? 'name';
		const columnId = columnIds.includes(wanted) ? wanted : (columnIds[0] ?? 'name');
		const workerId =
			activeCell && rows.some((row) => row.id === activeCell!.workerId)
				? activeCell.workerId
				: first.id;
		return { workerId, columnId };
	});

	function activateCell(workerId: string, columnId: string) {
		activeCell = { workerId, columnId };
	}

	/** Column order, changed by dragging a header or Alt+Arrow on a focused one. */
	const columnOrder = createWorkersColumnOrder({
		allColumnIds: () => table.getAllLeafColumns().map((column) => column.id),
		visibleColumnIds: () => table.getVisibleLeafColumns().map((column) => column.id),
		setColumnOrder: (order) => table.setColumnOrder(order),
		columnLabel: (columnId) => table.getColumn(columnId)?.columnDef.meta?.label,
		viewport: () => scrollViewport
	});

	/**
	 * Saved Workers views. A view opens as an editable copy: its filters ride the address
	 * through the filter state below, while sort, columns and order are set here directly
	 * and so reset to the table's defaults on reload. The Name search is never part of one.
	 */
	const savedViews = createSavedViews({
		kind: 'workers',
		api: {
			list: listViews,
			create: createView,
			update: updateView,
			remove: deleteView
		},
		vocabulary: () => ({ attributes, languages, agitations }),
		capture: () => {
			const state = table.store.get();
			return {
				version: 1,
				kind: 'workers',
				workers: captureWorkersView(
					{
						filterValue: (columnId) => table.getColumn(columnId)?.getFilterValue(),
						sorting: state.sorting ?? [],
						columnVisibility: state.columnVisibility ?? {},
						columnOrder: state.columnOrder ?? []
					},
					{ attributes, languages, agitations }
				)
			};
		},
		apply: (snapshot) => {
			if (!snapshot.workers) return;
			const target = workersViewToTable(snapshot.workers, { attributes, languages, agitations });
			const search = table.getColumn('name')?.getFilterValue();
			table.setColumnFilters([
				...target.columnFilters,
				...(typeof search === 'string' && search ? [{ id: 'name', value: search }] : [])
			]);
			table.setSorting(target.sorting);
			table.setColumnVisibility(target.columnVisibility);
			table.setColumnOrder(target.columnOrder);
		}
	});

	/** Arrow movement, focus and Shift ranges across the rows. */
	const keyboard = createWorkersKeyboard({
		rowIds: () => rows.map((row) => row.id),
		viewport: () => scrollViewport,
		scrollToRow: (index) => virtualization.scrollToIndex(index),
		flushDrafts: () => editModel.flushDrafts(),
		selection,
		creating: () => !!newWorker,
		isGrid: () => !mobileViewport.current,
		currentColumnId: () => effectiveActive?.columnId ?? 'name',
		select: (workerId) => {
			person.workersSelectedId = workerId;
			captureCohort({ workerId, columnId: effectiveActive?.columnId ?? 'name' });
		},
		activate: activateCell
	});

	/** Space on a row: flips its checkbox through the same first-check gate as a click. */
	function onToggleRow(workerId: string, checked: boolean) {
		if (keyboard.endRange()) return;
		void selection.toggle(workerId, checked);
	}

	/** Esc on the table, when no field or dialog took it: clear the checked rows, else close the open Worker. */
	function onViewportKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		const target = event.target;
		if (target instanceof HTMLInputElement && target.type !== 'checkbox') return;
		keyboard.endRange();
		if (selection.count > 0) selection.clear();
		else if (person.workersSelectedId !== null) closeRecordPanel();
		else return;
		event.preventDefault();
	}

	/** Close the desktop card: drop the selection (or cancel creating) and return focus to the row. */
	function closeRecordPanel() {
		const id = person.workersSelectedId;
		const origin = person.workersReturn?.sourceFocus?.workerId ?? null;
		if (newWorker) cancelNewWorker();
		else dropRecord();
		if (id === null) return;
		void tick().then(() => {
			const find = (workerId: string | null) =>
				workerId === null
					? null
					: (scrollViewport?.querySelector<HTMLElement>(
							`tr[data-worker-id="${CSS.escape(workerId)}"]`
						) ?? null);
			// The originating row, else the closed Worker's row, else the filter bar.
			const row = find(origin) ?? find(id);
			if (!row) {
				document.querySelector<HTMLElement>('[data-worker-search]')?.focus();
				return;
			}
			// In the grid the cell takes focus, not the row.
			const column = mobileViewport.current ? null : (effectiveActive?.columnId ?? 'name');
			const cell = column
				? row?.querySelector<HTMLElement>(`td[data-column-id="${CSS.escape(column)}"]`)
				: null;
			(cell ?? row)?.focus();
		});
	}

	/**
	 * The row index of a Worker a delete is about to remove, read while its row is
	 * still in the model, so focus can land on the row that takes its place.
	 */
	let removalRowIndex: number | null = null;

	/** Records where a delete started, so its success can put focus back in the grid. */
	function noteRemoval(workerId: string) {
		removalRowIndex = rows.findIndex((row) => row.id === workerId);
	}

	/**
	 * Puts focus back in the grid once the control that held it has been removed by
	 * its own action (a delete, or clearing the selection). The captured row index
	 * lands on the Worker that took the deleted one's place; with none captured the
	 * active cell is the fallback. The closing dialog or record card restores focus to
	 * its own trigger a few frames later, so the placement is re-checked for a short
	 * window and re-applied only while focus is still lost; a real focus elsewhere is
	 * never stolen.
	 */
	function focusGridAfterRemoval() {
		const index = removalRowIndex;
		removalRowIndex = null;
		/** True while a placement is in flight, so a frame does not start a second one. */
		let placing = false;

		const place = () => {
			if (placing) return;
			const active = document.activeElement;
			const focusLost =
				!(active instanceof HTMLElement) || active === document.body || !active.isConnected;
			if (!focusLost) return;
			const row = index === null ? undefined : rows[Math.min(Math.max(index, 0), rows.length - 1)];
			const workerId = row?.id ?? effectiveActive?.workerId;
			if (workerId) {
				placing = true;
				void keyboard
					.focusCell(
						workerId,
						mobileViewport.current ? null : (effectiveActive?.columnId ?? 'name')
					)
					.finally(() => (placing = false));
				return;
			}
			// The last Worker went: the table is empty, so its New Worker control takes focus.
			document.querySelector<HTMLElement>('[data-new-worker-trigger]')?.focus();
		};

		void tick().then(() => {
			const until = performance.now() + 400;
			const step = () => {
				place();
				if (performance.now() < until) requestAnimationFrame(step);
			};
			requestAnimationFrame(step);
		});
	}

	type TableRow = ReturnType<typeof table.getRowModel>['rows'][number];
	const mobileViewport = new IsMobile();
	const reducedMotion = $derived(motionIsReduced());
	/** How far the record card slides in from the right, in px. */
	const CARD_SLIDE_PX = 288;
	/** How long the record card takes to slide in, in ms; reduced motion skips it. */
	const CARD_MOTION_MS = 220;
	// opacity stays 1: fly's default fade-in leaves the translucent glass see-through, so the
	// Workers table shows through the card while it travels, and the backdrop blur pops at the end.
	const cardMotion = $derived({
		x: CARD_SLIDE_PX,
		opacity: 1,
		duration: reducedMotion ? 0 : CARD_MOTION_MS
	});
	const tableColspan = $derived(table.getVisibleLeafColumns().length);

	const nameRem = $derived(nameColumnRem(data.map((worker) => worker.name)));

	/** Overflow cues and the shrink factor that fits the columns to the frame. */
	const columnFit = createWorkersColumnFit({
		viewport: () => scrollViewport,
		columns: () =>
			table.getVisibleLeafColumns().map((column) => ({
				id: column.id,
				width: column.columnDef.meta?.width,
				minWidth: column.columnDef.meta?.minWidth,
				grow: column.columnDef.meta?.grow
			})),
		nameRem: () => nameRem
	});

	const rows = $derived(table.getRowModel().rows);

	/**
	 * Selection (rail on desktop, sheet below it): one Worker, view-owned, separate from the bulk-edit
	 * checkboxes. The selected record is read back out of the row model — never
	 * a cached Worker — so a row that leaves the model (filter, delete) stops
	 * resolving and the panel empties with it.
	 */
	/**
	 * New Worker in progress: a placeholder row that exists only here until a name is
	 * committed. `person.workersSelectedId` is left alone while it is open, so cancelling
	 * simply closes it and the previous selection is still there.
	 */
	let newWorker = $state<{ open: true } | null>(null);
	/**
	 * Below `lg` the record opens in a sheet, but only from an explicit row activation
	 * (click, tap, Enter): an open Worker carried over from a wider window, or one still
	 * open after a resize, never opens it. Cleared on close and when the window widens.
	 */
	let sheetRequested = $state(false);
	/**
	 * The sheet shows "N Selected" instead of a Worker: set by tapping the bulk bar's
	 * count (also an explicit activation), kept through the sheet's slide-out so it
	 * never flashes the empty hint, and dropped on the next row activation.
	 */
	let summaryMode = $state(false);
	$effect(() => {
		if (!mobileViewport.current) {
			sheetRequested = false;
			summaryMode = false;
		}
	});
	$effect(() => {
		if (selection.count === 0 && summaryMode) {
			summaryMode = false;
			sheetRequested = false;
		}
	});
	function openSummary() {
		summaryMode = mobileViewport.current;
		sheetRequested = mobileViewport.current;
	}
	const selectedRow = $derived(
		person.workersSelectedId === null
			? undefined
			: rows.find((row) => row.id === person.workersSelectedId)
	);

	/**
	 * A Worker created while the list could not refresh: the record stays open on the
	 * stored Worker until the table's data carries it.
	 */
	let createdFallback = $state<Worker | null>(null);
	/**
	 * The open record, resolved against every Worker, not the filtered rows: a Worker
	 * created or edited out of the filters stays open, with a note.
	 */
	const selectedWorker = $derived.by(() => {
		const id = person.workersSelectedId;
		if (id === null) return undefined;
		return (
			data.find((worker) => worker.id === id) ??
			(createdFallback?.id === id ? createdFallback : undefined)
		);
	});
	const outsideFilters = $derived(!!selectedWorker && !selectedRow);

	const liveIds = $derived(new Set(data.map((worker) => worker.id)));
	const isLive = (id: string) => liveIds.has(id) || createdFallback?.id === id;
	const cohortAt = $derived(cohortPosition(person.workersCohort, person.workersSelectedId, isLive));
	/** Every Worker of the list the record was opened from is gone: the card shows a way back. */
	const cohortEmpty = $derived(
		person.workersSelectedId === null && cohortExhausted(person.workersCohort, isLive)
	);

	function currentFiltersHash() {
		return filterParamsKey(new URLSearchParams(window.location.search));
	}

	/** Snapshots the rows now as the cohort Previous and Next walk, and where closing returns to. */
	function captureCohort(sourceFocus: { workerId: string; columnId: string } | null) {
		person.workersCohort = rows.map((row) => row.id);
		person.workersReturn = {
			sourceRoute: 'workers',
			sourceFocus,
			returnFiltersHash: currentFiltersHash()
		};
	}

	/** Drops the open record and its cohort; the return context goes with them. */
	function dropRecord() {
		person.workersSelectedId = null;
		person.workersCohort = [];
		person.workersReturn = null;
	}

	/** Focus into the open record's heading, where a cohort step lands. */
	async function focusRecordHeading() {
		await tick();
		document
			.querySelector<HTMLElement>('[data-testid="record-panel"] [data-record-heading]')
			?.focus();
	}

	/** Previous or Next: save what is typed first; a refused save keeps the record and its input. */
	async function stepCohort(direction: -1 | 1) {
		const target = direction < 0 ? cohortAt.previousId : cohortAt.nextId;
		if (target === null) return;
		if (!(await editModel.flushDrafts())) return;
		person.workersSelectedId = target;
		sheetRequested = mobileViewport.current;
		const index = rows.findIndex((row) => row.id === target);
		if (index >= 0) virtualization.scrollToIndex(index);
		await focusRecordHeading();
	}

	/** The way back from the record: closes it and puts focus where the organizer came from. */
	const cohort = $derived({
		position: cohortAt.position,
		total: cohortAt.total,
		hasPrevious: cohortAt.previousId !== null,
		hasNext: cohortAt.nextId !== null,
		outsideFilters,
		empty: cohortEmpty,
		onPrevious: () => void stepCohort(-1),
		onNext: () => void stepCohort(1),
		onReturn: returnToList
	});

	function returnToList() {
		sheetRequested = false;
		closeRecordPanel();
	}

	/** What a screen reader hears when a deliberate filter or sort change rebuilds the list. */
	let cohortNotice = $state('');
	let intentKey: string | null = null;
	// Only the organizer's own filter or sort change rebuilds the cohort. Mount
	// normalization rewrites the address, never these columns, so it cannot reach here.
	$effect(() => {
		const key = JSON.stringify([
			filterColumnIds.map((columnId) => table.getColumn(columnId)?.getFilterValue() ?? null),
			table.getAllLeafColumns().map((column) => column.getIsSorted())
		]);
		const previous = intentKey;
		intentKey = key;
		if (previous === null || previous === key) return;
		untrack(() => void rebuildCohort());
	});

	async function rebuildCohort() {
		await tick();
		const ids = rows.map((row) => row.id);
		person.workersCohort = ids;
		const sourceFocus = person.workersReturn?.sourceFocus ?? null;
		const hadRecord = person.workersSelectedId !== null || person.workersReturn !== null;
		if (!hadRecord) return;
		person.workersReturn = {
			sourceRoute: 'workers',
			sourceFocus,
			returnFiltersHash: currentFiltersHash()
		};
		const first = rows[0];
		// A record still among the new rows keeps its place; one that left them moves to the first.
		const stillShown = ids.includes(person.workersSelectedId ?? '');
		if (person.workersSelectedId !== null && first && !stillShown) {
			if (!(await editModel.flushDrafts())) {
				cohortNotice = m.workers_cohort_rebuilt_blocked();
				return;
			}
			person.workersSelectedId = first.id;
			sheetRequested = mobileViewport.current;
		}
		const shownId = person.workersSelectedId;
		const name = rows.find((row) => row.id === shownId)?.original.name ?? first?.original.name;
		cohortNotice = name
			? m.workers_cohort_rebuilt({
					name,
					position: Math.max(1, ids.indexOf(shownId ?? '') + 1),
					count: ids.length
				})
			: m.workers_cohort_rebuilt_empty();
	}

	/**
	 * What a screen reader hears when the desktop record opens: the panel's own label.
	 * Cleared on close so reopening the same Worker announces again; the sheet below
	 * `lg` is a dialog and announces itself.
	 */
	let recordNotice = $state('');
	$effect(() => {
		if (mobileViewport.current || !selectedWorker) {
			recordNotice = '';
			return;
		}
		recordNotice = m.workers_panel_details_named({ name: selectedWorker.name });
	});

	/** Checking a row closes the desktop card for good: the open Worker is dropped, not parked. */
	$effect(() => {
		if (!mobileViewport.current && selection.count > 0 && !newWorker)
			person.workersSelectedId = null;
	});
	const cardOpen = $derived(!!newWorker || !!selectedWorker || cohortEmpty);

	/** What the desktop card last showed; the outro keeps showing it once the selection is gone. */
	let heldCard = $state<{
		worker: (typeof rows)[number]['original'] | null;
		creating: boolean;
		checkedCount: number;
	}>({ worker: null, creating: false, checkedCount: 0 });
	$effect.pre(() => {
		if (cardOpen) {
			heldCard = {
				worker: newWorker ? null : (selectedWorker ?? null),
				creating: !!newWorker,
				checkedCount: 0
			};
		}
	});

	/**
	 * A row click. Anything being typed in the panel is saved first; a draft the
	 * core refuses keeps the selection where it was and leaves the editor open.
	 */
	async function onSelectWorker(workerId: string): Promise<boolean> {
		summaryMode = false;
		if (workerId === person.workersSelectedId && !newWorker) {
			sheetRequested = mobileViewport.current;
			return true;
		}
		if (!(await editModel.flushDrafts())) return false;
		person.workersSelectedId = workerId;
		sheetRequested = mobileViewport.current;
		return true;
	}

	/** Selects the Worker on the Mapping (private memory, never the address) and opens it. */
	function onShowOnMapping(workerId: string) {
		person.mapSelectedId = workerId;
		void goto(resolve('/mapping'));
	}

	/** A row opened from the table: the record opens and the rows now showing become its cohort. */
	async function onOpenRow(workerId: string): Promise<boolean> {
		const opened = await onSelectWorker(workerId);
		if (opened) {
			captureCohort({ workerId, columnId: effectiveActive?.columnId ?? 'name' });
		}
		return opened;
	}

	/** New Worker: save open panel drafts, then open the placeholder row. */
	async function beginNewWorker() {
		if (newWorker) return;
		if (!(await editModel.flushDrafts())) return;
		newWorker = { open: true };
		// The placeholder row is inserted at the top: bring the top into view so
		// it is seen arriving, rather than the rows under the pointer sliding away.
		scrollViewport?.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
	}

	function cancelNewWorker() {
		newWorker = null;
		// The placeholder (and the Name field holding focus) is gone: hand focus back
		// to the control that opened it, so keyboard users do not restart from the top.
		void tick().then(() =>
			document.querySelector<HTMLElement>('[data-new-worker-trigger]')?.focus()
		);
	}

	/**
	 * Creates the Worker the placeholder named. Answers false when the core refused,
	 * so the Name editor stays open with what was typed.
	 */
	async function createNewWorker(
		name: string,
		attributes: WorkerAttributeValues
	): Promise<boolean> {
		if (!newWorker) return true;
		let created: Worker;
		try {
			created = await onCreateWorker(name, attributes);
		} catch {
			return false;
		}
		let refreshed = true;
		try {
			await onRefresh();
		} catch {
			// The Worker exists; the next reload shows it.
			refreshed = false;
			createdFallback = created;
		}
		await tick();
		person.workersSelectedId = created.id;
		captureCohort(null);
		sheetRequested = mobileViewport.current;
		newWorker = null;
		// Undo is bound to this Worker by value (ticket 25).
		const createdId = created.id;
		const remove = onDeleteWorker;
		const refresh = onRefresh;
		const added = refreshed
			? `Added ${created.name}`
			: m.workers_added_not_refreshed({ name: created.name });
		editModel.setStatus(added, async () => {
			await remove(createdId);
			await refresh();
		});
		return true;
	}

	// The top bar's New Worker: answer each request made after this table mounted.
	let answeredNewWorkerRequests = untrack(() => editModel.newWorkerRequests);
	$effect(() => {
		const requests = editModel.newWorkerRequests;
		if (requests === answeredNewWorkerRequests) return;
		answeredNewWorkerRequests = requests;
		untrack(() => void beginNewWorker());
	});

	/** Focus entering the grid (Tab, or a click on the viewport) lands on the active cell. */
	function onViewportFocus(event: FocusEvent) {
		if (event.target !== event.currentTarget || mobileViewport.current || !effectiveActive) return;
		void keyboard.focusCell(effectiveActive.workerId, effectiveActive.columnId);
	}

	// The open record stays open through filters; it closes only when the Worker is gone.
	$effect(() => {
		if (createdFallback && data.some((worker) => worker.id === createdFallback!.id))
			createdFallback = null;
		if (person.workersSelectedId !== null && !selectedWorker) person.workersSelectedId = null;
	});

	const renderItems = $derived.by(() => {
		const items: DataTableRenderItem<TableRow>[] = [];
		for (const row of rows) items.push({ key: row.id, row });
		return items;
	});

	const virtualization = createDataTableVirtualizer(
		() => renderItems,
		() => scrollViewport,
		table.getRowModel().rows.length
	);
	const activeRowMounted = $derived(
		!!effectiveActive &&
			virtualization.virtualItems.some(
				(item) => renderItems[item.index]?.key === effectiveActive.workerId
			)
	);

	/** The filterable columns, in the order the filter bar presents them. */
	const filterColumnIds = $derived([
		'name',
		'languages',
		'assessment',
		...attributes.map((a) => a.id),
		'agitations'
	]);

	/** The filters as the address encodes them, and what the table is filtered by in words. */
	const urlFilters = createWorkersUrlFilters({
		filterValue: (columnId) => table.getColumn(columnId)?.getFilterValue(),
		attributes: () => attributes,
		agitations: () => agitations
	});

	const nameSearchActive = $derived.by(() => {
		const search = table.getColumn('name')?.getFilterValue();
		return typeof search === 'string' && search.length > 0;
	});

	function clearSearch() {
		table.getColumn('name')?.setFilterValue(undefined);
	}

	function clearFilters() {
		for (const columnId of filterColumnIds) {
			table.getColumn(columnId)?.setFilterValue(undefined);
		}
	}
</script>

<!-- Padding leaves room for the panel's ring and shadow; nothing above this clips overflow.
     The bottom edge sits where the Mapping canvas's does: flush with the shell's gutter.
     Below lg there is no panel, so the card runs down over the shell's bottom gutter
     (1rem) and the bulk bar, last in the card, ends at the bottom of the viewport. -->
<div
	class="relative flex h-full min-h-0 min-w-0 flex-col px-1 pt-1 pb-0 max-lg:h-[calc(100%+1rem)] max-lg:shrink-0"
>
	<div class="relative flex min-h-0 min-w-0 flex-1 gap-4">
		<div
			class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-surface bg-panel shadow-surface"
		>
			<p class="sr-only" aria-live="polite" aria-atomic="true" data-testid="workers-column-notice">
				{columnOrder.columnMoveNotice}
			</p>
			<p class="sr-only" aria-live="polite" aria-atomic="true" data-testid="workers-record-notice">
				{recordNotice}
			</p>
			<p class="sr-only" aria-live="polite" aria-atomic="true" data-testid="workers-cohort-notice">
				{cohortNotice}
			</p>
			<DataTableFilterBar
				{table}
				{attributes}
				{agitations}
				{languages}
				{savedViews}
				workerCount={table.getFilteredRowModel().rows.length}
			/>
			<SavedViewReviewDialog views={savedViews} {attributes} />
			<div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div
					bind:this={scrollViewport}
					data-testid="workers-scroll-viewport"
					data-scrollbar-stable
					data-overflow={columnFit.overflowing}
					data-keyboard-nav={keyboard.navigating}
					tabindex={!mobileViewport.current && effectiveActive && !activeRowMounted ? 0 : undefined}
					onpointermove={() => keyboard.setNavigating(false)}
					onpointerdown={() => {
						keyboard.setNavigating(false);
						keyboard.endRange();
					}}
					onkeydown={onViewportKeydown}
					onfocus={onViewportFocus}
					style="--workers-table-name-w: {nameRem}rem;"
					class="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto overscroll-x-none **:data-[slot=table-container]:overflow-visible! [&[data-overflow=true]_[data-pin=name]]:shadow-[inset_-1px_0_0_var(--rule)]"
				>
					<Table.Root
						role={mobileViewport.current ? undefined : 'grid'}
						aria-label={m.workers_table_label()}
						aria-rowcount={mobileViewport.current ? undefined : rows.length + 1}
						aria-colcount={mobileViewport.current ? undefined : tableColspan}
						class="w-auto table-fixed p-0"
						style={columnFit.style}
					>
						<Table.Header class="sticky top-0 z-20 bg-panel">
							{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
								<Table.Row aria-rowindex={mobileViewport.current ? undefined : 1}>
									{#each headerGroup.headers as header (header.id)}
										{@const sorted = header.column.getIsSorted()}
										{@const meta = header.column.columnDef.meta}
										<Table.Head
											colspan={header.colSpan}
											data-column-id={header.column.id}
											draggable={columnOrder.isMovableColumn(header.column.id) ? 'true' : undefined}
											data-dragging={columnOrder.draggingColumnId === header.column.id || undefined}
											data-drop-target={columnOrder.dropTargetColumnId === header.column.id ||
												undefined}
											ondragstart={(event: DragEvent) =>
												columnOrder.onHeaderDragStart(event, header.column.id)}
											ondragover={(event: DragEvent) =>
												columnOrder.onHeaderDragOver(event, header.column.id)}
											ondragleave={() => columnOrder.onHeaderDragLeave(header.column.id)}
											ondrop={(event: DragEvent) =>
												columnOrder.onHeaderDrop(event, header.column.id)}
											ondragend={columnOrder.clearColumnDrag}
											onkeydown={(event: KeyboardEvent) =>
												columnOrder.onHeaderKeydown(event, header.column.id)}
											data-pin={meta?.pin}
											style={columnStyle(meta)}
											aria-sort={!header.column.getCanSort()
												? undefined
												: sorted === 'asc'
													? 'ascending'
													: sorted === 'desc'
														? 'descending'
														: 'none'}
											class={cn(
												// A column header is a column label, so it takes the
												// label role's step. The vendored head reaches for
												// `text-2xs`, one step down, which would leave a fixed
												// header smaller than the sortable one beside it.
												'label',
												meta?.widthClass,
												pinClass(meta),
												header.column.id === 'selection' && 'py-1 lg:py-2',
												header.column.id === 'name' && 'overflow-hidden',
												header.column.id === 'assessment' && 'whitespace-normal',
												columnOrder.draggingColumnId === header.column.id && 'opacity-50',
												columnOrder.dropTargetColumnId === header.column.id &&
													'shadow-[inset_2px_0_0_var(--action)]'
											)}
										>
											{#if !header.isPlaceholder}
												<FlexRender {header} />
											{/if}
										</Table.Head>
									{/each}
								</Table.Row>
							{/each}
						</Table.Header>
						<Table.Body>
							{#if newWorker}
								<Table.Row data-testid="new-worker-row" aria-current="true" class={workersRowClass}>
									{#each table.getVisibleLeafColumns() as column (column.id)}
										{@const meta = column.columnDef.meta}
										<Table.Cell
											data-pin={meta?.pin}
											style={columnStyle(meta)}
											class={cn(meta?.widthClass, pinClass(meta))}
										>
											{#if column.id === 'name'}
												<span class="block truncate text-ink-3">{m.workers_unnamed_worker()}</span>
											{/if}
										</Table.Cell>
									{/each}
								</Table.Row>
							{/if}
							{#if rows.length === 0 && !newWorker}
								<Table.Row>
									<Table.Cell colspan={tableColspan} class="h-32">
										<div class="mx-auto flex max-w-prose flex-col items-center gap-1 text-center">
											{#if data.length === 0}
												<p class="text-sm font-medium">{m.workers_empty_title()}</p>
												<p class="text-sm text-muted-foreground">{m.workers_empty_body()}</p>
												<Button
													class="mt-2 min-h-tap lg:min-h-8"
													data-add-first-worker
													onclick={() => editModel.requestNewWorker()}
												>
													{m.workers_add_first_worker()}
												</Button>
											{:else}
												<p class="text-sm font-medium">
													{m.workers_no_match({
														filters: formatList(urlFilters.activeFilterNames)
													})}
												</p>
												<p class="text-sm text-muted-foreground">
													{m.workers_clear_filters_hint({ count: data.length })}
												</p>
												<div class="mt-2 flex flex-wrap justify-center gap-2">
													{#if nameSearchActive}
														<Button
															variant="outline"
															class="min-h-tap lg:min-h-8"
															onclick={clearSearch}
														>
															{m.workers_clear_search()}
														</Button>
													{/if}
													<Button
														variant="outline"
														class="min-h-tap lg:min-h-8"
														onclick={clearFilters}
													>
														{m.workers_clear_filters()}
													</Button>
												</div>
											{/if}
										</div>
									</Table.Cell>
								</Table.Row>
							{:else}
								{#if virtualization.paddingTop > 0}
									<DataTableVirtualSpacer
										height={virtualization.paddingTop}
										colspan={tableColspan}
									/>
								{/if}
								{#each virtualization.virtualItems as virtualItem (virtualItem.key)}
									{@const item = renderItems[virtualItem.index]}
									{#if item}
										<DataTableRow
											bind:rowRef={virtualization.rowElements[virtualItem.index]}
											row={item.row}
											virtualIndex={virtualItem.index}
											rowIndex={rows.indexOf(item.row) + 2}
											onSelect={onOpenRow}
											onClose={closeRecordPanel}
											onMove={keyboard.move}
											onToggle={onToggleRow}
											grid={!mobileViewport.current}
											activeColumnId={effectiveActive?.workerId === item.row.id
												? effectiveActive.columnId
												: null}
											onActivate={activateCell}
											checked={selection.isSelected(item.row.id)}
											open={!newWorker && item.row.id === person.workersSelectedId}
										/>
									{/if}
								{/each}
								{#if virtualization.paddingBottom > 0}
									<DataTableVirtualSpacer
										height={virtualization.paddingBottom}
										colspan={tableColspan}
									/>
								{/if}
							{/if}
						</Table.Body>
					</Table.Root>
				</div>
				{#if columnFit.overflowing && !columnFit.scrolledToEnd}
					<div
						data-testid="workers-scroll-fade"
						aria-hidden="true"
						class="pointer-events-none absolute inset-y-0 right-0 w-10 bg-linear-to-l from-panel to-transparent"
					></div>
				{/if}
			</div>
			<!-- At lg the footer is one fixed-height slot: the hint line, or the bulk bar laid
			     over it, and the status line floats above it — none of them resizes the table.
			     Below lg the bar stays in flow under the status line, and its measured height
			     keeps the fixed status line clear of the bar's actions. -->
			<div
				class="relative flex shrink-0 flex-col max-lg:flex-col-reverse lg:h-12"
				style="--bulk-bar-height: {bulkBarHeight}px"
			>
				{#if selection.count === 0}
					<p
						data-testid="shortcut-hint"
						class="hidden h-full items-center border-t border-rule px-4 text-xs text-ink-3 lg:flex"
					>
						{m.workers_shortcut_hint()}
					</p>
				{/if}
				<DataTableBulkBar
					{selection}
					workers={data}
					{attributes}
					{languages}
					{reportEdit}
					onOpenSummary={openSummary}
					bind:barRef={bulkBarElement}
					onBeforeDelete={noteRemoval}
					onAfterDelete={focusGridAfterRemoval}
					onFocusReturn={focusGridAfterRemoval}
				/>
				<StatusLine />
			</div>
		</div>
		{#if !mobileViewport.current && cardOpen}
			<div
				class="absolute -top-1 right-0 -bottom-2.5 z-30 flex min-h-0"
				data-testid="record-card"
				transition:fly={cardMotion}
			>
				<RecordPanel
					onClose={closeRecordPanel}
					worker={heldCard.worker}
					creating={heldCard.creating
						? { onCreate: createNewWorker, onCancel: cancelNewWorker }
						: null}
					checkedCount={heldCard.checkedCount}
					workers={data}
					{attributes}
					{agitations}
					{languages}
					{onUpdateLanguages}
					onAddAnother={() => void beginNewWorker()}
					{onShowOnMapping}
					{onSelectWorker}
					{cohort}
					{onUpdateField}
					{onUpdateAssessment}
					{onUpdateAttribute}
					{onAddNote}
					{onDeleteNote}
					{onDeleteWorker}
					{onEditNote}
					{onRestoreNote}
					{onAddRelationship}
					{onRemoveRelationship}
					{onAssignAgitation}
					{onUnassignAgitation}
					{onCreateAgitation}
					{onRefresh}
					onEditSaved={reportEdit}
					onBeforeDelete={noteRemoval}
					onAfterDelete={focusGridAfterRemoval}
				/>
			</div>
		{/if}
	</div>
</div>
{#if mobileViewport.current}
	<RecordPanel
		presentation="sheet"
		worker={newWorker || !sheetRequested || summaryMode ? null : (selectedWorker ?? null)}
		checkedCount={summaryMode ? selection.count : 0}
		summaryOpen={summaryMode && sheetRequested && !newWorker}
		creating={newWorker ? { onCreate: createNewWorker, onCancel: cancelNewWorker } : null}
		workers={data}
		{attributes}
		{agitations}
		{languages}
		{onUpdateLanguages}
		onAddAnother={() => void beginNewWorker()}
		{onShowOnMapping}
		{onSelectWorker}
		{cohort}
		{onUpdateField}
		{onUpdateAssessment}
		{onUpdateAttribute}
		{onAddNote}
		{onDeleteNote}
		{onDeleteWorker}
		{onEditNote}
		{onRestoreNote}
		{onAddRelationship}
		{onRemoveRelationship}
		{onAssignAgitation}
		{onUnassignAgitation}
		{onCreateAgitation}
		{onRefresh}
		onEditSaved={reportEdit}
		onBeforeDelete={noteRemoval}
		onAfterDelete={focusGridAfterRemoval}
		onClose={() => {
			sheetRequested = false;
			if (newWorker) cancelNewWorker();
			else if (!summaryMode) dropRecord();
		}}
	/>
{/if}
