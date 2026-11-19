/**
 * The New Worker placeholder: the row the grid inserts at the top, the panel that names it, and
 * the Worker it becomes. The grid owns the panel, the rows and the status line; this owns the
 * flow — when the placeholder may open, what a refused or unrefreshed create does, and what is
 * reported after it.
 */
import type { Worker, WorkerAttributeValues } from '#lib/domain-vocabulary.ts';

/** What the placeholder reads from the grid and asks it to do. */
export type NewWorkerHost = {
	/** Saves whatever the open panel is editing; a refusal keeps the placeholder closed. */
	flushDrafts: () => Promise<boolean>;
	/** Creates the Worker the placeholder named. */
	create: (name: string, attributes: WorkerAttributeValues) => Promise<Worker>;
	/** Reloads the grid's data; a failure keeps the created Worker reachable. */
	refresh: () => Promise<void>;
	/** Remembers the created Worker so the record can open on it before the rows carry it. */
	rememberCreated: (worker: Worker) => void;
	/**
	 * Opens the record on the created Worker, after the rows have rendered. It runs before the
	 * placeholder closes, so the card never shows neither.
	 */
	openCreated: (worker: Worker) => Promise<void>;
	/** Reports the add, with the Undo the grid builds from the created Worker. */
	reportAdded: (name: string, refreshed: boolean, created: Worker) => void;
	/** Brings the placeholder row into view. */
	reveal: () => void;
	/** Hands focus back to the control that opened the placeholder. */
	focusTrigger: () => void;
};

export function createNewWorker(host: NewWorkerHost) {
	/** Whether the placeholder row is open. */
	let open = $state(false);

	/** New Worker: save open panel drafts, then open the placeholder row. */
	async function begin() {
		if (open) return;
		if (!(await host.flushDrafts())) return;
		open = true;
		host.reveal();
	}

	function cancel() {
		open = false;
		host.focusTrigger();
	}

	/**
	 * Creates the Worker the placeholder named. Answers false when the core refused, so the Name
	 * editor stays open with what was typed.
	 */
	async function create(name: string, attributes: WorkerAttributeValues): Promise<boolean> {
		if (!open) return true;
		let created: Worker;
		try {
			created = await host.create(name, attributes);
		} catch {
			return false;
		}
		let refreshed = true;
		try {
			await host.refresh();
		} catch {
			// The Worker exists; the next reload shows it.
			refreshed = false;
			host.rememberCreated(created);
		}
		await host.openCreated(created);
		open = false;
		host.reportAdded(created.name, refreshed, created);
		return true;
	}

	return {
		get open() {
			return open;
		},
		begin,
		cancel,
		create
	};
}
