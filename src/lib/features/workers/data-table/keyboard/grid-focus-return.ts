/**
 * Where keyboard focus goes when the control that held it is removed by its own action: a
 * closed record card, a deleted Worker, a cleared selection. The grid owns the table and the
 * active cell; this owns the placement, including the short window after a removal in which
 * the closing dialog may still hand focus back to its own trigger.
 */
import { tick } from 'svelte';

/** What the placement reads from the grid. */
export type GridFocusHost = {
	/** The table's scroll container, where the row elements live. */
	viewport: () => HTMLElement | null;
	/** The rows the table shows now, in order. */
	rows: () => readonly { id: string }[];
	/** The cell that takes focus on Tab, or null while the table has no rows. */
	activeCell: () => { workerId: string; columnId: string } | null;
	/** Whether the narrow card layout is showing: its rows take focus, not a cell. */
	isMobile: () => boolean;
	focusCell: (workerId: string, columnId: string | null) => Promise<unknown>;
};

/** The browser the placement runs in; a spec replaces it with a fake. */
export type GridFocusEnvironment = {
	/** Resolves once the DOM has caught up with the state change that asked for focus. */
	settle: () => Promise<void>;
	frame: (step: () => void) => void;
	now: () => number;
	/** The row element of a Worker, if mounted. */
	row: (viewport: HTMLElement | null, workerId: string) => HTMLElement | null;
	cell: (row: HTMLElement, columnId: string) => HTMLElement | null;
	/** True when focus is on the page body or on an element that has left the document. */
	focusLost: () => boolean;
	focusSearch: () => void;
	focusNewWorkerTrigger: () => void;
};

/** How long a removal keeps re-checking that focus did not fall to the page. */
export const PLACEMENT_WINDOW_MS = 400;

const browser: GridFocusEnvironment = {
	settle: () => tick(),
	frame: (step) => void requestAnimationFrame(step),
	now: () => performance.now(),
	row: (viewport, workerId) =>
		viewport?.querySelector<HTMLElement>(`tr[data-worker-id="${CSS.escape(workerId)}"]`) ?? null,
	cell: (row, columnId) =>
		row.querySelector<HTMLElement>(`td[data-column-id="${CSS.escape(columnId)}"]`),
	focusLost: () => {
		const active = document.activeElement;
		return !(active instanceof HTMLElement) || active === document.body || !active.isConnected;
	},
	focusSearch: () => document.querySelector<HTMLElement>('[data-worker-search]')?.focus(),
	focusNewWorkerTrigger: () =>
		document.querySelector<HTMLElement>('[data-new-worker-trigger]')?.focus()
};

export function createGridFocusReturn(host: GridFocusHost, env: GridFocusEnvironment = browser) {
	/**
	 * The row index of a Worker a delete is about to remove, read while its row is still in the
	 * model, so focus can land on the row that takes its place.
	 */
	let removalRowIndex: number | null = null;

	const activeColumn = () => (host.isMobile() ? null : (host.activeCell()?.columnId ?? 'name'));

	return {
		/**
		 * After the record card closes: the originating row, else the closed Worker's row, else
		 * the filter bar. In the grid the active column's cell takes focus, not the row.
		 */
		async afterClose(closedId: string, originId: string | null) {
			await env.settle();
			const find = (workerId: string | null) =>
				workerId === null ? null : env.row(host.viewport(), workerId);
			const row = find(originId) ?? find(closedId);
			if (!row) {
				env.focusSearch();
				return;
			}
			const column = activeColumn();
			const cell = column ? env.cell(row, column) : null;
			(cell ?? row).focus();
		},

		/** Records where a delete started, so its success can put focus back in the grid. */
		noteRemoval(workerId: string) {
			removalRowIndex = host.rows().findIndex((row) => row.id === workerId);
		},

		/**
		 * Puts focus back in the grid once the control that held it has been removed by its own
		 * action (a delete, or clearing the selection). The captured row index lands on the
		 * Worker that took the deleted one's place; with none captured the active cell is the
		 * fallback. The closing dialog or record card restores focus to its own trigger a few
		 * frames later, so the placement is re-checked for a short window and re-applied only
		 * while focus is still lost; a real focus elsewhere is never stolen.
		 */
		async afterRemoval() {
			const index = removalRowIndex;
			removalRowIndex = null;
			/** True while a placement is in flight, so a frame does not start a second one. */
			let placing = false;

			const place = () => {
				if (placing || !env.focusLost()) return;
				const rows = host.rows();
				const row =
					index === null ? undefined : rows[Math.min(Math.max(index, 0), rows.length - 1)];
				const workerId = row?.id ?? host.activeCell()?.workerId;
				if (workerId) {
					placing = true;
					void host.focusCell(workerId, activeColumn()).finally(() => (placing = false));
					return;
				}
				// The last Worker went: the table is empty, so its New Worker control takes focus.
				env.focusNewWorkerTrigger();
			};

			await env.settle();
			const until = env.now() + PLACEMENT_WINDOW_MS;
			const step = () => {
				place();
				if (env.now() < until) env.frame(step);
			};
			env.frame(step);
		}
	};
}
