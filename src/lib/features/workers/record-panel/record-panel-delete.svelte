<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.ts';
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import DeleteConfirmDialog from '../data-table/delete-confirm-dialog.svelte';
	import { createDataTableActionState } from '../data-table/data-table-action-state.svelte.ts';
	import { runSingleEdit } from '../data-table/data-table-bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import { m } from '#lib/paraglide/messages.js';

	type Props = {
		worker: Worker;
		onDelete: (workerId: string) => Promise<void>;
		/** Reloads the Workers table; kept apart from `onDelete` so a reload failure is not a delete failure. */
		refresh: () => Promise<void>;
		/** Told when the deletion landed but the Workers table could not be reloaded. */
		onReport: (report: DataTableEditReport) => void;
		/** Called before the write, while the row is still in the table, so focus can follow it. */
		onBeforeDelete?: (workerId: string) => void;
		/** Called once the deletion landed: the table puts focus back where the record was. */
		onAfterDelete?: () => void;
	};

	let { worker, onDelete, refresh, onReport, onBeforeDelete, onAfterDelete }: Props = $props();

	let alertOpen = $state(false);
	const deletion = createDataTableActionState();
	/** The refusal copy, complete for this Worker and the applied language. */
	const deleteFailed = $derived(m.workers_delete_worker_fallback({ worker: worker.name }));

	async function confirmDelete() {
		// Read now: the record leaves the table as the deletion lands.
		onBeforeDelete?.(worker.id);
		const outcome: { report?: DataTableEditReport } = {};
		await deletion.run(async () => {
			// No restore: a deletion has no Undo, only a reload that can be retried.
			outcome.report = await runSingleEdit({
				apply: () => onDelete(worker.id),
				refresh,
				summary: m.workers_delete_worker_summary({ worker: worker.name }),
				fallback: deleteFailed
			});
		}, deleteFailed);

		const report = outcome.report;
		if (!report) return;
		if (report.error) {
			deletion.setError(deleteFailed);
			return;
		}
		alertOpen = false;
		if (report.refreshError) onReport(report);
		// The dialog's own trigger unmounts with the record: hand focus back to the table.
		onAfterDelete?.();
	}
</script>

<div class="border-t border-rule pt-4">
	<Button
		type="button"
		variant="outline"
		class="text-destructive"
		onclick={() => {
			deletion.clearError();
			alertOpen = true;
		}}
	>
		{m.workers_delete_worker_action()}
	</Button>
</div>

<DeleteConfirmDialog
	bind:open={alertOpen}
	subject={worker.name}
	pending={deletion.pending}
	errorMessage={deletion.errorMessage}
	onConfirm={confirmDelete}
>
	{m.workers_delete_worker_body({ worker: worker.name })}
</DeleteConfirmDialog>
