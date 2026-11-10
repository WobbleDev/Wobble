<script lang="ts">
	import { refreshWorkers } from '#lib/features/workers/refresh-workers.ts';
	import DataTable from '#lib/features/workers/data-table/data-table.svelte';
	import { columnsKey, createColumns } from '#lib/features/workers/data-table/columns.ts';
	import {
		addWorkerNote as addWorkerNoteRequest,
		addWorkerRelationship as addWorkerRelationshipRequest,
		assignWorkerAgitation as assignWorkerAgitationRequest,
		createAgitation as createAgitationRequest,
		createWorker as createWorkerRequest,
		deleteWorker as deleteWorkerRequest,
		deleteWorkerNote as deleteWorkerNoteRequest,
		editWorkerNote as editWorkerNoteRequest,
		removeWorkerRelationship as removeWorkerRelationshipRequest,
		restoreWorkerNote as restoreWorkerNoteRequest,
		unassignWorkerAgitation as unassignWorkerAgitationRequest,
		updateWorkerAssessment as updateWorkerAssessmentRequest,
		updateWorkerAttribute as updateWorkerAttributeRequest,
		updateWorkerField as updateWorkerFieldRequest,
		updateWorkerLanguages as updateWorkerLanguagesRequest
	} from '#lib/client/workers-api.ts';
	import type {
		AssessmentOption,
		Agitation,
		WorkerAttributeValue,
		WorkerAttributeValues,
		WorkerNote,
		WorkerNoteEdit,
		WorkerNoteInput,
		WorkerTextField
	} from '#lib/domain-vocabulary.ts';
	import { page } from '$app/state';
	import { personState } from '#lib/shared/person-state.svelte.ts';
	import { parseWorkerFilters, toColumnFilters } from '#lib/shared/worker-filters.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let columnsMemo: { key: string; columns: ReturnType<typeof createColumns> } | undefined;
	const columns = $derived.by(() => {
		const key = columnsKey(data.attributes, data.agitations, data.languages);
		if (columnsMemo?.key !== key) {
			columnsMemo = {
				key,
				columns: createColumns(data.attributes, data.agitations, data.languages)
			};
		}
		return columnsMemo.columns;
	});
	// The address names Attributes by id; parsing needs the Worksite vocabulary so a
	// condition that names a deleted Attribute is dropped rather than applied.
	const initialFilters = $derived(
		toColumnFilters(
			parseWorkerFilters(new URLSearchParams(page.url.search), data.attributes, data.agitations)
		)
	);
	const person = $derived(personState.forWorksite(data.worksite?.id));

	// A legacy link's q, sel and worker are ignored and stripped with the filter
	// normalization; the open record comes from private renderer memory or a user action.

	function updateAttribute(workerId: string, attributeId: string, value: WorkerAttributeValue) {
		return updateWorkerAttributeRequest(workerId, attributeId, value);
	}

	function updateAssessment(workerId: string, assessment: AssessmentOption) {
		return updateWorkerAssessmentRequest(workerId, assessment);
	}

	function updateLanguages(workerId: string, languageIds: string[]) {
		return updateWorkerLanguagesRequest(workerId, languageIds);
	}

	async function updateField(workerId: string, field: WorkerTextField, value: string) {
		await updateWorkerFieldRequest(workerId, field, value);
	}

	function addNote(workerId: string, note: WorkerNoteInput) {
		return addWorkerNoteRequest(workerId, note);
	}

	async function editNote(workerId: string, edit: WorkerNoteEdit) {
		await editWorkerNoteRequest(workerId, edit);
	}

	async function deleteNote(workerId: string, noteId: string) {
		await deleteWorkerNoteRequest(workerId, noteId);
	}

	async function restoreNote(workerId: string, note: WorkerNote) {
		await restoreWorkerNoteRequest(workerId, note);
	}

	function deleteWorker(workerId: string) {
		return deleteWorkerRequest(workerId);
	}

	function createAgitation(text: string): Promise<Agitation> {
		return createAgitationRequest(text);
	}

	function createWorker(name: string, attributes: WorkerAttributeValues) {
		return createWorkerRequest(name, attributes);
	}

	async function addRelationship(workerId: string, otherWorkerId: string) {
		await addWorkerRelationshipRequest(workerId, otherWorkerId);
	}

	async function removeRelationship(workerId: string, otherWorkerId: string) {
		await removeWorkerRelationshipRequest(workerId, otherWorkerId);
	}

	async function assignAgitation(workerId: string, agitationId: string) {
		await assignWorkerAgitationRequest(workerId, agitationId);
	}

	async function unassignAgitation(workerId: string, agitationId: string) {
		await unassignWorkerAgitationRequest(workerId, agitationId);
	}
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col">
	<DataTable
		data={data.workers}
		{columns}
		attributes={data.attributes}
		agitations={data.agitations}
		languages={data.languages}
		{initialFilters}
		{person}
		onUpdateAttribute={updateAttribute}
		onUpdateAssessment={updateAssessment}
		onUpdateLanguages={updateLanguages}
		onUpdateField={updateField}
		onAddNote={addNote}
		onDeleteNote={deleteNote}
		onEditNote={editNote}
		onRestoreNote={restoreNote}
		onAddRelationship={addRelationship}
		onRemoveRelationship={removeRelationship}
		onAssignAgitation={assignAgitation}
		onUnassignAgitation={unassignAgitation}
		onCreateAgitation={createAgitation}
		onCreateWorker={createWorker}
		onDeleteWorker={deleteWorker}
		onRefresh={refreshWorkers}
	/>
</div>
