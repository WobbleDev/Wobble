<script lang="ts">
	/**
	 * Contact: Email and Phone as two lines in the panel header, under the Name and
	 * Assessment. Each is one row that edits in place: the icon stays, the text becomes an
	 * input in the same box, and Save and Cancel take the trailing slot. A value shows on a
	 * single line and truncates with "…" when it cannot fit, the whole of it in the tooltip.
	 * The copy button has that slot to itself, so it never overlaps the text.
	 */
	import RecordPanelField from './record-panel-field.svelte';
	import type { DataTableEditReport } from '../data-table/features.ts';
	import { restoreWorkerField } from '#lib/client/worker-writes-api.ts';
	import type { Worker, WorkerTextField } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import MailIcon from '@lucide/svelte/icons/mail';
	import PhoneIcon from '@lucide/svelte/icons/phone';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { getEditModel } from '#lib/features/workers/edit-model.svelte.ts';

	let {
		worker,
		onUpdateField,
		refresh,
		onSaved
	}: {
		worker: Worker;
		/** Writes one of the Worker's free-text fields; the core validates it. */
		onUpdateField: (workerId: string, field: WorkerTextField, value: string) => Promise<void>;
		refresh: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
	} = $props();

	/** The copy button waits for hover or focus where a pointer exists; on touch it always shows. */
	const copyReveal =
		'opacity-0 group-hover/kv:opacity-100 group-focus-within/kv:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';

	const editModel = getEditModel();

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

<div role="group" aria-label={m.workers_contact_heading()}>
	<dl class="grid gap-0.5">
		<!-- One editor per Worker: a selection change closes whoever's was open. -->
		{#key worker.id}
			<div class="min-w-0">
				<!-- The icon says it to the eye; the term says it to a screen reader. -->
				<dt class="sr-only">{m.workers_field_email()}</dt>
				<dd class="min-w-0">
					<RecordPanelField
						inline
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
					>
						{#snippet lead()}<MailIcon class="size-3.5" aria-hidden="true" />{/snippet}
						{#snippet trail()}
							{#if worker.email}
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									class={copyReveal}
									aria-label={m.workers_copy_email()}
									onclick={() => void copy(m.workers_field_email(), worker.email)}
								>
									<CopyIcon />
								</Button>
							{/if}
						{/snippet}
					</RecordPanelField>
				</dd>
			</div>
			<div class="num min-w-0">
				<dt class="sr-only">{m.workers_field_phone()}</dt>
				<dd class="min-w-0">
					<RecordPanelField
						inline
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
					>
						{#snippet lead()}<PhoneIcon class="size-3.5" aria-hidden="true" />{/snippet}
						{#snippet trail()}
							{#if worker.phone}
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									class={copyReveal}
									aria-label={m.workers_copy_phone()}
									onclick={() => void copy(m.workers_field_phone(), worker.phone)}
								>
									<CopyIcon />
								</Button>
							{/if}
						{/snippet}
					</RecordPanelField>
				</dd>
			</div>
		{/key}
	</dl>
</div>
