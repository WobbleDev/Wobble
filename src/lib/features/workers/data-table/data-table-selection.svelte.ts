/**
 * The Workers table's checkbox selection: worker ids held in a SvelteSet so it
 * survives filtering, sorting and virtualization — a virtualizer mounts only
 * the rows in view, so any state the rows own rusts; this state lives beside
 * them instead.
 *
 * The header checkbox acts on the rows the filters currently match, not on the
 * whole Workers table, and not on the handful of rows the virtualizer happens to have
 * mounted. Ids selected before a filter was applied stay selected; the difference
 * between the two counts is reported as "outside filters" rather than quietly
 * included in a batch.
 */
import { SvelteSet } from 'svelte/reactivity';
import type { Worker } from '#lib/domain-vocabulary.ts';

export function createWorkersSelection(
	getWorkers: () => readonly Worker[],
	/**
	 * Runs before the first row is checked (count 0 to 1 or more), because that swaps the
	 * record panel for its summary and unmounts any open editor. Answers false when an
	 * editor refused to save; the check is then abandoned and the editor stays open.
	 */
	beforeFirstCheck?: () => Promise<boolean>
) {
	const selected = new SvelteSet<string>();

	/** The filtered row model's ids, kept in step by the table that owns it. */
	let matchingIds = $state<readonly string[]>([]);

	/** Ids still among the Workers table's workers, in Workers table order. */
	const liveSelection = $derived.by(() => {
		const workers = getWorkers();
		return workers.filter((worker) => selected.has(worker.id)).map((worker) => worker.id);
	});

	const count = $derived(liveSelection.length);

	/** The ids the Workers table still carries, for an O(1) answer per rendered row. */
	const liveIds = $derived(new SvelteSet(liveSelection));

	/** Selected Workers the filters still show. */
	const matchingSelected = $derived(matchingIds.filter((id) => liveIds.has(id)).length);

	/** Selected Workers the filters hide; a batch still covers them, so it must be said. */
	const outsideFilterCount = $derived(count - matchingSelected);

	const allMatchingSelected = $derived(
		matchingIds.length > 0 && matchingSelected === matchingIds.length
	);
	const someMatchingSelected = $derived(
		matchingSelected > 0 && matchingSelected < matchingIds.length
	);

	function isSelected(workerId: string): boolean {
		return liveIds.has(workerId);
	}

	/** Applies `apply` now, or after the gate when it takes the count from 0 up. Answers whether it applied. */
	function gated(checked: boolean, apply: () => void): boolean | Promise<boolean> {
		if (checked && beforeFirstCheck && count === 0) {
			return beforeFirstCheck().then((ok) => {
				if (ok) apply();
				return ok;
			});
		}
		apply();
		return true;
	}

	/** The visible (filtered and sorted) row order, kept in step by the table; shift-click ranges run over it. */
	let visibleIds: readonly string[] = [];
	/** The last row whose checkbox was toggled: the fixed end of a shift-click range. */
	let anchorId: string | null = null;

	function setVisibleIds(ids: readonly string[]) {
		visibleIds = [...ids];
	}

	/** Checks or unchecks one row; with `range`, every visible row from the anchor to it. */
	function toggle(workerId: string, checked: boolean, range = false) {
		const from = range && anchorId !== null ? visibleIds.indexOf(anchorId) : -1;
		const to = visibleIds.indexOf(workerId);
		const ids =
			from >= 0 && to >= 0
				? visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1)
				: [workerId];
		return gated(checked, () => {
			anchorId = workerId;
			for (const id of ids) {
				if (checked) {
					selected.add(id);
				} else {
					selected.delete(id);
				}
			}
		});
	}

	/** The header checkbox: adds or removes the filter matches, and only those. */
	function setAllMatching(checked: boolean) {
		return gated(checked, () => {
			for (const id of matchingIds) {
				if (checked) {
					selected.add(id);
				} else {
					selected.delete(id);
				}
			}
		});
	}

	function setKeyboardRange(ids: readonly string[], retained: readonly string[]) {
		return gated(true, () => {
			selected.clear();
			for (const id of [...retained, ...ids]) selected.add(id);
		});
	}

	function clear() {
		selected.clear();
	}

	/**
	 * Called by the table whenever its filtered row model changes. The header
	 * checkbox governs these ids — every match, mounted or not — while ids
	 * selected before a filter was applied stay selected.
	 */
	function setMatchingIds(ids: readonly string[]) {
		matchingIds = [...ids];
	}

	return {
		/** The ids actually on the Workers table, in Workers table order. */
		get liveSelection() {
			return liveSelection;
		},
		/** How many Workers the batch would cover, filtered or not. */
		get count() {
			return count;
		},
		/** How many matched rows the filters currently show. */
		get matchingCount() {
			return matchingIds.length;
		},
		/** Selected Workers the current filters hide. */
		get outsideFilterCount() {
			return outsideFilterCount;
		},
		get allMatchingSelected() {
			return allMatchingSelected;
		},
		get someMatchingSelected() {
			return someMatchingSelected;
		},
		setKeyboardRange,
		isSelected,
		toggle,
		setAllMatching,
		setMatchingIds,
		setVisibleIds,
		clear
	};
}

export type WorkersSelection = ReturnType<typeof createWorkersSelection>;
