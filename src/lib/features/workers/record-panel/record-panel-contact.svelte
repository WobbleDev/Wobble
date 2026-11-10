<script lang="ts">
	/** Contact: Email and Phone, each edited where it is shown. */
	import RecordPanelField from './record-panel-field.svelte';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import { restoreWorkerField } from '#lib/client/workers-api.ts';
	import type { Worker, WorkerTextField } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { getPanelDraft } from './panel-draft-state.svelte.ts';
	import { getEditModel } from '#lib/features/workers/edit-model.svelte.ts';

	let {
		worker,
		headingId,
		onUpdateField,
		refresh,
		onSaved
	}: {
		worker: Worker;
		headingId: string;
		/** Writes one of the Worker's free-text fields; the core validates it. */
		onUpdateField: (workerId: string, field: WorkerTextField, value: string) => Promise<void>;
		refresh: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
	} = $props();

	const editModel = getEditModel();
	const panelDraft = getPanelDraft();

	/** Puts one contact value on the clipboard and says so in the status line. */
	async function copy(label: string, value: string) {
		try {
			await navigator.clipboard.writeText(value);
			editModel.setStatus(m.workers_copied({ field: label }));
		} catch {
			editModel.fail(m.workers_copy_failed());
		}
	}

	/** The field's write, bound to this Worker by value (see ticket 25). */
	function saveField(workerId: string, field: WorkerTextField) {
		return (value: string) => onUpdateField(workerId, field, value);
	}
</script>

<section aria-labelledby={headingId} class="grid gap-3">
	<h3 id={headingId} class="label">{m.workers_contact_heading()}</h3>
	<dl class="grid gap-3">
		<!-- One editor per Worker: a selection change closes whoever's was open. -->
		{#key worker.id}
			<div class="grid min-w-0 gap-1">
				<dt class="key">{m.workers_field_email()}</dt>
				<dd class="prose-value flex min-w-0 items-center gap-1 text-sm">
					<div class="min-w-0 flex-1">
						<RecordPanelField
							label={m.workers_field_email()}
							fieldKind="email"
							editLabel={m.workers_edit_email()}
							type="email"
							value={worker.email}
							placeholder={m.workers_add_email()}
							workerName={worker.name}
							draftKey="email"
							onSave={saveField(worker.id, 'email')}
							{refresh}
							{onSaved}
						/>
					</div>
					{#if worker.email && panelDraft.open.email === undefined}
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={m.workers_copy_email()}
							onclick={() => void copy(m.workers_field_email(), worker.email)}
						>
							<CopyIcon />
						</Button>
					{/if}
				</dd>
			</div>
			<div class="grid min-w-0 gap-1">
				<dt class="key">{m.workers_field_phone()}</dt>
				<dd class="num prose-value flex min-w-0 items-center gap-1 text-sm">
					<div class="min-w-0 flex-1">
						<RecordPanelField
							label={m.workers_field_phone()}
							fieldKind="phone"
							editLabel={m.workers_edit_phone()}
							type="tel"
							mask="phone"
							value={worker.phone}
							placeholder={m.workers_add_phone()}
							inputPlaceholder={m.workers_phone_placeholder()}
							workerName={worker.name}
							draftKey="phone"
							onSave={saveField(worker.id, 'phone')}
							onRestore={async (value) => {
								await restoreWorkerField(worker.id, 'phone', value);
							}}
							{refresh}
							{onSaved}
						/>
					</div>
					{#if worker.phone && panelDraft.open.phone === undefined}
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={m.workers_copy_phone()}
							onclick={() => void copy(m.workers_field_phone(), worker.phone)}
						>
							<CopyIcon />
						</Button>
					{/if}
				</dd>
			</div>
		{/key}
	</dl>
</section>
