<script lang="ts">
	/**
	 * The panel header: the Worker's Name as the region's h2, made editable where it
	 * is shown, and the Assessment under it as the same dropdown the table cell uses.
	 */
	import { assessmentColorFor } from '#lib/shared/assessment.ts';
	import { assessmentOptions, type AssessmentOption } from '#lib/domain-vocabulary.ts';
	import type { Snippet } from 'svelte';
	import type { Worker, WorkerTextField } from '#lib/domain-vocabulary.ts';
	import DataTableOptionCell from '../data-table/data-table-option-cell.svelte';
	import RecordPanelField from './record-panel-field.svelte';
	import { getEditModel } from '../edit-model.svelte.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import { assessmentChoices } from '../answers.ts';
	import { m } from '#lib/paraglide/messages.js';

	let {
		worker,
		onUpdateField,
		onUpdateAssessment,
		refresh,
		onSaved,
		actions
	}: {
		worker: Worker;
		/** Writes one of the Worker's free-text fields; the core validates it. */
		onUpdateField: (workerId: string, field: WorkerTextField, value: string) => Promise<void>;
		/** Writes the Worker's Assessment. */
		onUpdateAssessment: (workerId: string, assessment: AssessmentOption) => Promise<void>;
		refresh: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
		/** A surface's own controls (the sheet's Close). */
		actions?: Snippet;
	} = $props();

	/** A refused write reports where every other failed write does. */
	const editModel = getEditModel();

	/** The Assessment write, bound to this Worker by value (see ticket 25). */
	function saveAssessment(workerId: string) {
		return (assessment: string) => onUpdateAssessment(workerId, assessment as AssessmentOption);
	}

	/** The field's write, bound to this Worker by value (see ticket 25). */
	function saveField(workerId: string, field: WorkerTextField) {
		return (value: string) => onUpdateField(workerId, field, value);
	}
</script>

<header class="flex shrink-0 items-start justify-between gap-2 border-b border-rule px-4 pt-4 pb-3">
	<div class="grid min-w-0 gap-1">
		<!-- One editor per Worker: a selection change closes whoever's was open. -->
		{#key worker.id}
			<RecordPanelField
				title
				label={m.workers_field_name()}
				fieldKind="name"
				editLabel={m.workers_edit_name()}
				editValueLabel={(value) => m.workers_edit_name_value({ value })}
				value={worker.name}
				placeholder={m.workers_add_name()}
				workerName={worker.name}
				draftKey="name"
				onSave={saveField(worker.id, 'name')}
				{refresh}
				{onSaved}
			/>
			<!-- The cell's own control, colour dots included. `px-2`
			     absorbs the trigger's negative margin, so the value lines up with the
			     Name above it and the button never widens the header. -->
			<div class="px-2 text-sm">
				<DataTableOptionCell
					type="single"
					workerName={worker.name}
					label={m.workers_field_assessment()}
					actionLabel={m.workers_assessment_action()}
					selected={worker.assessment}
					options={assessmentChoices(assessmentOptions)}
					swatch={assessmentColorFor(worker.assessment)}
					swatchFor={(option) => assessmentColorFor(option as AssessmentOption)}
					onUpdate={saveAssessment(worker.id)}
					onFailed={(message) => editModel.fail(message)}
					{onSaved}
					{refresh}
					fallbackMessage={m.workers_assessment_save_failed()}
					invalidMessage={m.workers_assessment_invalid()}
				/>
			</div>
		{/key}
	</div>
	<div class="flex shrink-0 items-center gap-1">
		{@render actions?.()}
	</div>
</header>
