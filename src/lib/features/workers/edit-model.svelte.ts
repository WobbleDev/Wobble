/**
 * The Workers view's edit model. Every saved change, whether a cell, a bulk
 * edit or a form, reports its message here with the request that takes it back,
 * and the status line in the table card's footer shows the latest one.
 *
 * It also holds the draft registry: an open panel editor registers its commit
 * here, so the view flushes what is being typed before the selection changes or
 * a bulk edit starts, instead of dropping it.
 */
import { getContext, setContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { DataTableEditReport } from '#lib/features/workers/data-table/data-table-features.ts';
import { m } from '#lib/paraglide/messages.js';
import { EDIT_STATUS_MS } from './edit-status.ts';

export type Status = {
	message: string;
	undo: (() => Promise<void>) | null;
};

/**
 * An open editor's way to save what has been typed. It resolves `true` once the
 * draft is saved (or there was nothing to save) and `false` when the write was
 * refused, in which case the editor stays open with its own message.
 */
export type DraftCommit = () => Promise<boolean>;

const editModelContextKey = Symbol('edit-model');

/**
 * The Workers view's edit model, from any component under the layout. Call it
 * during component init, never inside a handler: there is no context to read
 * there, and a missing model used to fail silently.
 */
export function getEditModel(): EditModel {
	const model = getContext<EditModel | undefined>(editModelContextKey);
	if (!model) {
		throw new Error(
			'getEditModel() found no edit model: call it during component init, under the layout that runs setEditModel().'
		);
	}
	return model;
}

export function setEditModel(): EditModel {
	return setContext(editModelContextKey, new EditModel());
}

export class EditModel {
	status = $state<Status | null>(null);
	/** Why the last Undo did not complete, in plain words; empty otherwise. */
	error = $state('');
	undoPending = $state(false);
	/** Bumped by the top bar's New Worker; the Workers table answers each bump once. */
	newWorkerRequests = $state(0);

	requestNewWorker() {
		this.newWorkerRequests += 1;
	}

	#timer: ReturnType<typeof setTimeout> | undefined;
	/** The open editors, by the commit that saves what they hold. */
	#drafts = new SvelteSet<DraftCommit>();

	/**
	 * Registers an open editor's commit and answers the function that takes it
	 * back off the registry. An editor registers while it is open, so its typing
	 * is flushed before the selection changes rather than thrown away.
	 */
	registerDraft(commit: DraftCommit): () => void {
		this.#drafts.add(commit);
		return () => {
			this.#drafts.delete(commit);
		};
	}

	/**
	 * Saves everything being typed. Answers `true` once nothing is left open, and
	 * `false` when an editor refused: its write did not land, it stays open with
	 * its own message, and the caller must not move the organizer off it.
	 */
	async flushDrafts(): Promise<boolean> {
		let flushed = true;

		// A snapshot, because a commit that lands unregisters itself as it closes.
		for (const commit of [...this.#drafts]) {
			// A commit that threw saved nothing, so it counts as refused too.
			const saved = await commit().catch(() => false);
			if (!saved) flushed = false;
		}

		return flushed;
	}

	/** Shows a message; it replaces any earlier one and restarts the clock. */
	setStatus(message: string, undo?: () => Promise<void>) {
		this.error = '';
		this.status = { message, undo: undo ?? null };
		this.#restartTimer();
	}

	/** Shows a failed write: no Undo, because nothing landed. */
	fail(message: string) {
		this.setStatus(message);
	}

	/**
	 * Shows a finished edit as the table reports it. The report's undo may
	 * stop part-way; that surfaces as a failed Undo, and pressing it again
	 * retries what is left.
	 */
	report(report: DataTableEditReport) {
		const { undo } = report;
		this.setStatus(
			report.message,
			undo &&
				(async () => {
					const result = await undo();
					if (result.error || result.refreshError || result.remaining > 0) {
						throw new Error(result.error ?? result.refreshError ?? m.workers_status_undo_stopped());
					}
				})
		);
		if (report.error) this.error = m.workers_status_partial_save();
		else if (report.refreshError) this.error = m.workers_status_refresh_failed();
	}

	/** Runs the inverse of the visible message, then reports "Undone". */
	async undo() {
		const shown = this.status;
		const inverse = shown?.undo;
		if (!shown || !inverse || this.undoPending) return;

		this.undoPending = true;
		this.error = '';
		clearTimeout(this.#timer);
		try {
			await inverse();
			// A newer message replaced this one while Undo ran; leave it alone.
			if (this.status === shown) this.setStatus(m.workers_status_undone());
		} catch {
			if (this.status === shown) {
				this.error = m.workers_status_undo_failed();
				this.#restartTimer();
			}
		} finally {
			this.undoPending = false;
		}
	}

	dispose() {
		clearTimeout(this.#timer);
	}

	#restartTimer() {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			// Nothing disappears under a running Undo; the timer restarts when it ends.
			if (this.undoPending) return;
			this.status = null;
			this.error = '';
		}, EDIT_STATUS_MS);
	}
}
