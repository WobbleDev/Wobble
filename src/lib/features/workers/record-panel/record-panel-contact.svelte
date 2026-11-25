<script lang="ts">
	/**
	 * Contact: Email and Phone as two lines in the panel header, under the Name and
	 * Assessment. Each is edited where it is shown. A value shows in full and breaks
	 * across lines only when it cannot fit; the copy button floats over its end on hover
	 * rather than keeping a gap of its own, so it never narrows the value.
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
	import { cn } from '#lib/utils.ts';
	import { getPanelDraft } from './panel-draft-state.svelte.ts';
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

	/**
	 * The copy buttons wait for hover or focus where a pointer exists, floating over the end of the
	 * value; on touch they always show, beside it.
	 */
	const copyReveal =
		'[@media(hover:hover)]:absolute [@media(hover:hover)]:inset-y-0 [@media(hover:hover)]:right-0 [@media(hover:hover)]:my-auto [@media(hover:hover)]:bg-inset [@media(hover:hover)]:opacity-0 group-hover/kv:opacity-100 focus-visible:opacity-100';

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

<div role="group" aria-label={m.workers_contact_heading()}>
	<dl class="grid gap-0.5">
		<!-- One editor per Worker: a selection change closes whoever's was open. -->
		{#key worker.id}
			<div
				class={cn(
					'group/kv grid min-w-0 items-center gap-x-1',
					panelDraft.open.email === undefined && 'grid-cols-[1rem_minmax(0,1fr)]'
				)}
			>
				{#if panelDraft.open.email === undefined}
					<MailIcon class="ml-2 size-3.5 text-ink-3" aria-hidden="true" />
				{/if}
				<!-- The icon says it to the eye; the term says it to a screen reader. -->
				<dt class="sr-only">{m.workers_field_email()}</dt>
				<dd class="relative flex min-w-0 items-center gap-1">
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
							class={copyReveal}
							aria-label={m.workers_copy_email()}
							onclick={() => void copy(m.workers_field_email(), worker.email)}
						>
							<CopyIcon />
						</Button>
					{/if}
				</dd>
			</div>
			<div
				class={cn(
					'group/kv num grid min-w-0 items-center gap-x-1',
					panelDraft.open.phone === undefined && 'grid-cols-[1rem_minmax(0,1fr)]'
				)}
			>
				{#if panelDraft.open.phone === undefined}
					<PhoneIcon class="ml-2 size-3.5 text-ink-3" aria-hidden="true" />
				{/if}
				<dt class="sr-only">{m.workers_field_phone()}</dt>
				<dd class="relative flex min-w-0 items-center gap-1">
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
							class={copyReveal}
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
</div>
