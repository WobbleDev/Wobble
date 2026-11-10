<script lang="ts">
	/**
	 * The Worker merge dialog: pick the surviving Worker, decide each conflict the core's
	 * preview names, and merge. Mounted only while open, so its model is born with the two
	 * Workers it was opened for.
	 */
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Dialog from '#lib/components/ui/dialog/index.ts';
	import {
		mergeWorkers,
		previewWorkerMerge,
		undoWorkerMerge,
		type MergeChoice
	} from '#lib/client/workers-api.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { assessmentLabel } from '#lib/i18n/assessment.ts';
	import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
	import { heldIdsOf } from '#lib/shared/select-mode.ts';
	import type {
		AssessmentOption,
		Worker,
		WorkerAttributeDefinition,
		WorkerAttributeValue
	} from '#lib/domain-vocabulary.ts';
	import { refreshWorkers } from '../refresh-workers.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import { createMergeModel } from './merge-model.svelte.ts';

	type Props = {
		workers: readonly [Worker, Worker];
		attributes: readonly WorkerAttributeDefinition[];
		/** Reports the finished merge so the table can confirm it and offer Undo. */
		onMerged: (report: DataTableEditReport) => void;
		onClose: () => void;
	};

	let { workers, attributes, onMerged, onClose }: Props = $props();

	let open = $state(true);

	const model = createMergeModel(
		{
			preview: previewWorkerMerge,
			merge: mergeWorkers,
			undo: undoWorkerMerge,
			refresh: refreshWorkers,
			copy: {
				failed: m.workers_merge_failed(),
				stale: m.workers_merge_stale(),
				undoExpired: m.workers_merge_undo_expired(),
				undoFailed: m.workers_merge_undo_failed(),
				reloadFailed: m.workers_reload_failed()
			}
		},
		workers
	);

	const scalarLabels: Record<string, () => string> = {
		name: () => m.workers_field_name(),
		email: () => m.workers_field_email(),
		phone: () => m.workers_field_phone(),
		assessment: () => m.workers_field_assessment()
	};

	function nameOf(id: string | null): string {
		return workers.find((worker) => worker.id === id)?.name ?? '';
	}

	function scalarValue(field: string, value: string): string {
		if (field === 'assessment') return assessmentLabel(value as AssessmentOption);
		return value;
	}

	function attributeValue(attributeId: string, value: unknown): string {
		const attribute = attributes.find((candidate) => candidate.id === attributeId);
		if (!attribute) return '';
		const ids = heldIdsOf(attribute, value as WorkerAttributeValue);
		return ids.length === 0
			? m.common_none()
			: ids.map((id) => answerDisplayLabel(attribute.answers, id)).join(', ');
	}

	function attributeName(attributeId: string): string {
		return attributes.find((candidate) => candidate.id === attributeId)?.name ?? attributeId;
	}

	async function confirm() {
		const survivorId = model.survivorId;
		const absorbedId = model.absorbedId;
		const result = await model.commit();
		if (!result) return;
		onMerged({
			message: m.workers_merge_done({
				absorbed: nameOf(absorbedId),
				survivor: nameOf(survivorId)
			}),
			undo: result.undo
		});
		open = false;
	}

	$effect(() => {
		if (!open) onClose();
	});

	const choices: readonly MergeChoice[] = ['survivor', 'absorbed'];
</script>

{#snippet contact(worker: Worker)}
	{#if worker.email || worker.phone}
		<span class="text-ink-3">{[worker.email, worker.phone].filter(Boolean).join(' · ')}</span>
	{/if}
{/snippet}

{#snippet decision(
	legend: string,
	name: string,
	values: readonly [string, string],
	chosen: MergeChoice | undefined,
	choose: (choice: MergeChoice) => void
)}
	<fieldset class="grid gap-1">
		<legend class="mb-1 font-medium">{legend}</legend>
		{#each choices as choice, index (choice)}
			<label class="flex min-h-tap items-center gap-2 lg:min-h-7">
				<input
					type="radio"
					{name}
					value={choice}
					checked={chosen === choice}
					onchange={() => choose(choice)}
				/>
				<span class="min-w-0 break-words">{values[index] || m.common_none()}</span>
			</label>
		{/each}
	</fieldset>
{/snippet}

<Dialog.Dialog bind:open>
	<Dialog.Content aria-describedby={undefined} data-testid="merge-dialog">
		<Dialog.Header>
			<Dialog.Title>{m.workers_merge_title()}</Dialog.Title>
		</Dialog.Header>

		<div class="grid max-h-[60vh] gap-4 overflow-y-auto">
			<fieldset class="grid gap-1">
				<legend class="mb-1 font-medium">{m.workers_merge_keep()}</legend>
				{#each workers as worker (worker.id)}
					<label class="flex min-h-tap items-start gap-2 py-1 lg:min-h-7">
						<input
							type="radio"
							name="merge-survivor"
							value={worker.id}
							class="mt-1"
							checked={model.survivorId === worker.id}
							onchange={() => void model.chooseSurvivor(worker.id)}
						/>
						<span class="grid min-w-0 break-words">
							<span>{worker.name}</span>
							{@render contact(worker)}
						</span>
					</label>
				{/each}
			</fieldset>

			{#if model.loading}
				<p class="text-ink-3">{m.common_loading()}</p>
			{/if}

			{#each model.blockedDrafts as workerId (workerId)}
				<p class="text-sm text-destructive" role="alert">
					{m.workers_merge_draft_blocked({ name: nameOf(workerId) })}
				</p>
			{/each}

			{#if model.preview}
				{@const preview = model.preview}
				{#each preview.scalarConflicts as conflict (conflict.field)}
					{@render decision(
						scalarLabels[conflict.field]?.() ?? conflict.field,
						`merge-${conflict.field}`,
						[
							scalarValue(conflict.field, conflict.survivor),
							scalarValue(conflict.field, conflict.absorbed)
						],
						model.scalarChoice(conflict.field),
						(choice) => model.decideScalar(conflict.field, choice)
					)}
				{/each}
				{#each preview.attributeConflicts as conflict (conflict.attributeId)}
					{@render decision(
						attributeName(conflict.attributeId),
						`merge-attribute-${conflict.attributeId}`,
						[
							attributeValue(conflict.attributeId, conflict.survivor),
							attributeValue(conflict.attributeId, conflict.absorbed)
						],
						model.attributeChoice(conflict.attributeId),
						(choice) => model.decideAttribute(conflict.attributeId, choice)
					)}
				{/each}

				<dl class="num grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-ink-3">
					<dt>{m.workers_notes_heading()}</dt>
					<dd>{preview.noteCount}</dd>
					<dt>{m.workers_agitations_heading()}</dt>
					<dd>{preview.agitationIds.length}</dd>
					<dt>{m.workers_column_languages()}</dt>
					<dd>{preview.languageIds.length}</dd>
					<dt>{m.workers_relationships_heading()}</dt>
					<dd>{preview.relationshipIds.length}</dd>
				</dl>
			{/if}

			{#if model.errorMessage}
				<p class="text-sm text-destructive" role="alert">{model.errorMessage}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" disabled={model.committing} onclick={() => (open = false)}>
				{m.common_cancel()}
			</Button>
			<Button disabled={!model.canMerge} onclick={confirm}>
				{model.committing ? m.workers_merge_pending() : m.workers_merge_confirm()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Dialog>
