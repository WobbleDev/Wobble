<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Dialog from '#lib/components/ui/dialog/index.ts';
	import { getWorksiteDataset } from '#lib/client/dataset-api.ts';
	import { importContacts } from '#lib/client/workers-api.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { filterParamsKey } from '../data-table/data-table-url-filters.svelte.ts';
	import {
		blankPhoneSummary,
		contactImportAction,
		contactImportComplete,
		duplicateRowSummary,
		skippedRowSummary
	} from '../copy.ts';
	import { createContactImport, type ImportError } from './contact-import-model.svelte.ts';
	import ContactCsvReview from './contact-csv-review.svelte';
	import { diagnosticsCsv, templateCsv } from './csv-import-review.ts';
	import { downloadText } from './download-text.ts';
	import { openCreatedWorkers } from './open-created-workers.ts';

	type Props = {
		open?: boolean;
		onClose?: () => void;
	};

	let { open = $bindable(false), onClose }: Props = $props();

	const model = createContactImport({
		async snapshot() {
			const dataset = await getWorksiteDataset();
			return {
				worksiteId: dataset.worksite?.id ?? null,
				worksiteName: dataset.worksite?.name ?? '',
				attributes: dataset.attributes,
				workers: dataset.workers.map(({ id, name, email, phone }) => ({ id, name, email, phone }))
			};
		},
		importRows: importContacts,
		refresh: invalidateAll,
		async openCreated(worksiteId, ids) {
			openCreatedWorkers(
				worksiteId,
				ids,
				filterParamsKey(new URLSearchParams(window.location.search))
			);
			open = false;
			onClose?.();
			await goto(resolve('/workers'));
		}
	});

	let fileInput = $state<HTMLInputElement | null>(null);

	function errorText(error: ImportError) {
		switch (error.code) {
			case 'parse':
				return m.workers_import_parse_error({ row: error.row });
			case 'empty':
				return m.workers_import_empty();
			case 'read_failed':
				return m.workers_import_read_failed();
			case 'stale_vocabulary':
				return m.workers_import_stale();
			case 'import_failed':
				return m.workers_import_failed();
		}
	}

	function handleFileChange(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (file) void model.chooseFile(file);
	}

	function downloadProblems() {
		downloadText(
			'import-problems.csv',
			diagnosticsCsv(model.rows, {
				row: m.workers_import_diag_row(),
				column: m.workers_import_diag_column(),
				problem: m.workers_import_diag_problem(),
				columns: { name: m.workers_import_diag_name(), phone: m.workers_import_diag_phone() },
				attributeName: (id) =>
					model.attributes.find((attribute) => attribute.id === id)?.name ?? '',
				problems: {
					name_required: m.workers_import_problem_name_required(),
					phone_not_ten_digits: m.workers_import_not_ten_digits(),
					possible_duplicate: m.workers_import_problem_possible_duplicate(),
					unknown_value: m.workers_import_problem_unknown_value(),
					ambiguous_value: m.workers_import_problem_ambiguous_value(),
					select_mode: m.workers_import_problem_select_mode(),
					trailing_backslash: m.workers_import_problem_trailing_backslash(),
					invalid_escape: m.workers_import_problem_invalid_escape(),
					empty_path_segment: m.workers_import_problem_empty_path_segment()
				}
			})
		);
	}

	function downloadTemplate() {
		downloadText(
			'contacts-template.csv',
			templateCsv([
				m.workers_import_table_name(),
				m.workers_import_table_phone(),
				m.workers_import_table_email()
			])
		);
	}
</script>

<Dialog.Root bind:open onOpenChange={(nextOpen) => !nextOpen && onClose?.()}>
	<!-- Cancel and Done already dismiss; only the preview stage has no other way out but Escape. -->
	<Dialog.Content
		class="max-h-[90vh] overflow-y-auto sm:max-w-4xl"
		showCloseButton={model.stage === 'review'}
	>
		<Dialog.Header>
			<Dialog.Title>{m.workers_import_title()}</Dialog.Title>
			<Dialog.Description>{m.workers_import_description()}</Dialog.Description>
		</Dialog.Header>

		{#if model.stage === 'complete'}
			<div class="grid gap-4">
				<p role="status">
					{contactImportComplete(model.result?.imported ?? 0)}
					{#if model.committedBlankPhones > 0}
						{blankPhoneSummary(model.committedBlankPhones)}
					{/if}
					{#if model.committedSkipped > 0}
						{skippedRowSummary(model.committedSkipped)}
					{/if}
					{#if model.committedDuplicateCount > 0}
						{duplicateRowSummary(model.committedDuplicateCount)}
					{/if}
				</p>
				{#if model.refreshFailed}
					<p class="text-sm text-destructive" role="alert">{m.workers_import_refresh_failed()}</p>
				{/if}
				<Dialog.Footer>
					<Button
						type="button"
						variant="outline"
						class="min-h-tap md:min-h-8"
						onclick={() => model.reset()}
					>
						{m.workers_import_another()}
					</Button>
					{#if model.committedDuplicateCount > 0 && !model.refreshFailed}
						<Button
							type="button"
							variant="outline"
							class="min-h-tap md:min-h-8"
							onclick={() => void model.continueToDuplicates()}
						>
							{m.workers_import_view_duplicates()}
						</Button>
					{/if}
					{#if (model.result?.created.length ?? 0) > 0 && !model.refreshFailed}
						<Button
							type="button"
							class="min-h-tap md:min-h-8"
							onclick={() => void model.continueToWorkers()}
						>
							{m.workers_import_view_workers()}
						</Button>
					{/if}
					<Dialog.Close>{m.common_done()}</Dialog.Close>
				</Dialog.Footer>
			</div>
		{:else}
			{#if model.stage === 'upload'}
				<div class="grid gap-3">
					<!-- The visible Button is the control; this label names and describes it, not the hidden input. -->
					<p id="contact-csv-file-label" class="label leading-none">
						{m.workers_import_label()}
					</p>
					<!-- The native input is hidden; the outline Button is its visible face. -->
					<div class="flex items-center gap-3">
						<!-- Kept raw: a visually hidden file input; the Button beside it is its visible trigger. -->
						<input
							bind:this={fileInput}
							id="contact-csv-file"
							type="file"
							accept=".csv,text/csv"
							class="sr-only"
							tabindex="-1"
							aria-labelledby="contact-csv-file-label"
							onchange={handleFileChange}
							disabled={model.reading}
						/>
						<Button
							type="button"
							variant="outline"
							class="min-h-tap md:min-h-8"
							aria-describedby="contact-csv-file-label"
							disabled={model.reading}
							onclick={() => fileInput?.click()}
						>
							{m.workers_import_choose()}
						</Button>
						<span class="min-w-0 truncate text-sm"
							>{model.fileName || m.workers_import_no_file()}</span
						>
					</div>
					<p class="text-sm text-muted-foreground">{m.workers_import_headers_hint()}</p>
					<div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							class="min-h-tap md:min-h-8"
							onclick={downloadTemplate}
						>
							{m.workers_import_template()}
						</Button>
					</div>
					{#if model.fileName && !model.error && model.reading}
						<p class="text-sm text-muted-foreground" role="status">{m.workers_import_reading()}</p>
					{/if}
				</div>
			{:else}
				<ContactCsvReview
					fileName={model.fileName}
					worksiteName={model.worksiteName}
					headers={model.headers}
					columns={model.columns}
					samples={model.samples}
					onColumn={model.setColumn}
					rows={model.rows}
					view={model.view}
					filter={model.filter}
					onFilter={model.setFilter}
					onPage={model.setPage}
					skippedCount={model.skippedCount}
					validContactCount={model.acceptedCount}
					problemRowCount={model.problemRowCount}
					onDownloadProblems={downloadProblems}
					attributes={model.attributes}
					attributeColumns={model.attributeColumns}
					attributeSamples={model.attributeSamples}
					onAttributeColumn={model.setAttributeColumn}
					undecidedCount={model.undecidedCount}
					onDecideAttribute={model.decideAttribute}
					onDecideDuplicate={model.decideDuplicate}
					onDecideAllAttributes={model.decideAllAttributes}
					onDecideAllDuplicates={model.decideAllDuplicates}
				/>
			{/if}

			{#if model.error}
				<p class="text-sm text-destructive" role="alert">{errorText(model.error)}</p>
			{/if}

			<Dialog.Footer>
				{#if model.stage === 'review'}
					<Button
						type="button"
						variant="outline"
						class="min-h-tap md:min-h-8"
						onclick={() => model.back()}
						disabled={model.importing}
					>
						{m.workers_import_back()}
					</Button>
					<Button
						type="button"
						class="min-h-tap md:min-h-8"
						onclick={() => void model.commit()}
						disabled={model.importing || model.acceptedCount === 0 || model.undecidedCount > 0}
					>
						{model.importing
							? m.workers_import_importing()
							: contactImportAction(model.acceptedCount)}
					</Button>
				{:else}
					<Dialog.Close disabled={model.reading}>{m.common_cancel()}</Dialog.Close>
				{/if}
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
