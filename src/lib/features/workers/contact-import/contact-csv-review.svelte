<script lang="ts">
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import CsvColumnSelect from './csv-column-select.svelte';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
	import type {
		AttributeDecision,
		DuplicateDecision,
		ReviewFilter,
		ReviewPage,
		ReviewRow
	} from './csv-import-review.ts';
	import type { CellProblem } from './attribute-cell.ts';
	import type { DuplicateReason } from './duplicate-signals.ts';
	import type { ContactCsvColumns } from './csv-import-utils.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { formatList } from '#lib/i18n/format.ts';

	type Props = {
		fileName: string;
		worksiteName: string;
		headers: string[];
		columns: ContactCsvColumns;
		samples: (role: keyof ContactCsvColumns) => string[];
		onColumn: (role: keyof ContactCsvColumns, index: number) => void;
		rows: readonly ReviewRow[];
		view: ReviewPage;
		filter: ReviewFilter;
		onFilter: (filter: ReviewFilter) => void;
		onPage: (page: number) => void;
		skippedCount: number;
		validContactCount: number;
		problemRowCount: number;
		onDownloadProblems: () => void;
		attributes: readonly WorkerAttributeDefinition[];
		attributeColumns: Readonly<Record<string, number>>;
		attributeSamples: (attributeId: string) => string[];
		onAttributeColumn: (attributeId: string, index: number) => void;
		undecidedCount: number;
		onDecideAttribute: (row: number, decision: AttributeDecision) => void;
		onDecideDuplicate: (row: number, decision: DuplicateDecision) => void;
		onDecideAllAttributes: (decision: AttributeDecision) => void;
		onDecideAllDuplicates: (decision: DuplicateDecision) => void;
	};

	let {
		fileName,
		worksiteName,
		headers,
		columns,
		samples,
		onColumn,
		rows,
		view,
		filter,
		onFilter,
		onPage,
		skippedCount,
		validContactCount,
		problemRowCount,
		onDownloadProblems,
		attributes,
		attributeColumns,
		attributeSamples,
		onAttributeColumn,
		undecidedCount,
		onDecideAttribute,
		onDecideDuplicate,
		onDecideAllAttributes,
		onDecideAllDuplicates
	}: Props = $props();

	// The select components bind a column; each change goes back to the model.
	let nameColumn = $state(0);
	let phoneColumn = $state(0);
	let emailColumn = $state(0);
	$effect.pre(() => {
		nameColumn = columns.name;
		phoneColumn = columns.phone;
		emailColumn = columns.email;
	});
	$effect(() => {
		if (nameColumn !== columns.name) onColumn('name', nameColumn);
		if (phoneColumn !== columns.phone) onColumn('phone', phoneColumn);
		if (emailColumn !== columns.email) onColumn('email', emailColumn);
	});

	const showAttributes = $derived(
		attributes.some((attribute) => (attributeColumns[attribute.id] ?? -1) >= 0)
	);
	const attributeName = (id: string) =>
		attributes.find((attribute) => attribute.id === id)?.name ?? '';
	const attributeProblemRows = $derived(
		rows.filter(
			(row) =>
				row.valid &&
				row.decisions.attribute === undefined &&
				row.attributes.some((entry) => entry.reading.problems.length > 0)
		).length
	);
	const duplicateRows = $derived(
		rows.filter((row) => row.duplicates.length > 0 && row.decisions.duplicate === undefined).length
	);

	const cellProblemLabels: Record<CellProblem['code'], () => string> = {
		unknown_value: () => m.workers_import_problem_unknown_value(),
		ambiguous_value: () => m.workers_import_problem_ambiguous_value(),
		select_mode: () => m.workers_import_problem_select_mode(),
		trailing_backslash: () => m.workers_import_problem_trailing_backslash(),
		invalid_escape: () => m.workers_import_problem_invalid_escape(),
		empty_path_segment: () => m.workers_import_problem_empty_path_segment()
	};
	const reasonLabels: Record<DuplicateReason, () => string> = {
		phone: () => m.workers_import_reason_phone(),
		email: () => m.workers_import_reason_email(),
		name: () => m.workers_import_reason_name()
	};

	function cellProblemLine(attributeId: string, problem: CellProblem) {
		const attribute = attributeName(attributeId);
		const label = cellProblemLabels[problem.code]();
		return problem.text
			? m.workers_import_cell_problem_text({ attribute, text: problem.text, problem: label })
			: m.workers_import_cell_problem({ attribute, problem: label });
	}

	function answersLine(row: ReviewRow) {
		return row.attributes
			.filter((entry) => entry.reading.ids.length > 0)
			.map((entry) => {
				const attribute = attributes.find((candidate) => candidate.id === entry.attributeId);
				const labels = entry.reading.ids.map((id) =>
					attribute ? answerDisplayLabel(attribute.answers, id) : id
				);
				return `${attributeName(entry.attributeId)}: ${formatList(labels)}`;
			});
	}

	const phoneProblemRowNumbers = $derived(
		rows.filter((row) => row.phoneProblem).map((row) => row.rowNumber)
	);
	const phoneProblemCount = $derived(phoneProblemRowNumbers.length);
	const firstPhoneProblemRows = $derived(phoneProblemRowNumbers.slice(0, 3));
	const phoneProblemRowList = $derived(
		formatList(firstPhoneProblemRows.map(String)) +
			(phoneProblemCount > firstPhoneProblemRows.length ? m.workers_import_more_rows() : '')
	);
</script>

<div class="grid gap-5">
	<div class="grid gap-1">
		<p class="font-medium">{fileName}</p>
		<p class="text-sm text-muted-foreground">
			{m.workers_import_worksite({ worksite: worksiteName })}
		</p>
		<p class="text-sm text-muted-foreground">{m.workers_import_columns_hint()}</p>
	</div>

	<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
		<CsvColumnSelect
			label={m.workers_import_name_required()}
			{headers}
			placeholder={m.workers_import_select_column()}
			samples={samples('name')}
			bind:selected={nameColumn}
		/>
		<CsvColumnSelect
			label={m.workers_import_phone_optional()}
			{headers}
			placeholder={m.workers_import_do_not_import()}
			samples={samples('phone')}
			bind:selected={phoneColumn}
		/>
		<CsvColumnSelect
			label={m.workers_import_email_optional()}
			{headers}
			placeholder={m.workers_import_do_not_import()}
			samples={samples('email')}
			bind:selected={emailColumn}
		/>
	</div>

	{#if attributes.length > 0}
		<div
			role="group"
			aria-label={m.workers_import_attributes_group()}
			class="grid grid-cols-1 gap-4 sm:grid-cols-3"
		>
			{#each attributes as attribute (attribute.id)}
				<CsvColumnSelect
					label={attribute.name}
					{headers}
					placeholder={m.workers_import_do_not_import()}
					samples={attributeSamples(attribute.id)}
					bind:selected={
						() => attributeColumns[attribute.id] ?? -1,
						(index) => onAttributeColumn(attribute.id, index)
					}
				/>
			{/each}
		</div>
	{/if}

	{#if columns.name >= 0 && skippedCount > 0}
		<p class="text-sm text-muted-foreground" role="status">
			{skippedCount === 1
				? m.workers_import_skipped_one()
				: m.workers_import_skipped_many({ count: skippedCount })}
		</p>
	{/if}
	<p class="text-sm text-muted-foreground">
		{validContactCount === 0
			? m.workers_import_valid_zero()
			: validContactCount === 1
				? m.workers_import_valid_one()
				: m.workers_import_valid_many({ count: validContactCount })}
	</p>
	{#if phoneProblemCount > 0}
		<p class="text-sm text-destructive" role="status">
			{phoneProblemCount === 1
				? m.workers_import_phone_problem_one({ rows: phoneProblemRowList })
				: m.workers_import_phone_problem_many({
						count: phoneProblemCount,
						rows: phoneProblemRowList
					})}
		</p>
	{/if}

	{#if undecidedCount > 0}
		<p class="text-sm text-destructive" role="status">
			{undecidedCount === 1
				? m.workers_import_undecided_one()
				: m.workers_import_undecided_many({ count: undecidedCount })}
		</p>
	{/if}
	{#if attributeProblemRows > 0}
		<div class="flex flex-wrap items-center gap-2">
			<p class="text-sm">{m.workers_import_bulk_attributes({ count: attributeProblemRows })}</p>
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="min-h-tap md:min-h-8"
				onclick={() => onDecideAllAttributes('omit')}
			>
				{m.workers_import_bulk_leave_out()}
			</Button>
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="min-h-tap md:min-h-8"
				onclick={() => onDecideAllAttributes('skip')}
			>
				{m.workers_import_bulk_skip()}
			</Button>
		</div>
	{/if}
	{#if duplicateRows > 0}
		<div class="flex flex-wrap items-center gap-2">
			<p class="text-sm">{m.workers_import_bulk_duplicates({ count: duplicateRows })}</p>
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="min-h-tap md:min-h-8"
				onclick={() => onDecideAllDuplicates('skip')}
			>
				{m.workers_import_bulk_skip()}
			</Button>
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="min-h-tap md:min-h-8"
				onclick={() => onDecideAllDuplicates('create')}
			>
				{m.workers_import_bulk_create()}
			</Button>
		</div>
	{/if}

	{#if columns.name >= 0}
		<div class="flex flex-wrap items-center gap-2">
			<div role="group" aria-label={m.workers_import_filter_label()} class="flex flex-wrap gap-2">
				<Button
					type="button"
					size="sm"
					class="min-h-tap md:min-h-8"
					variant={filter === 'all' ? 'secondary' : 'outline'}
					aria-pressed={filter === 'all'}
					onclick={() => onFilter('all')}
				>
					{m.workers_import_filter_all({ count: rows.length })}
				</Button>
				<Button
					type="button"
					size="sm"
					class="min-h-tap md:min-h-8"
					variant={filter === 'problems' ? 'secondary' : 'outline'}
					aria-pressed={filter === 'problems'}
					onclick={() => onFilter('problems')}
				>
					{m.workers_import_filter_problems({ count: problemRowCount })}
				</Button>
			</div>
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="min-h-tap md:ms-auto md:min-h-8"
				disabled={problemRowCount === 0}
				onclick={onDownloadProblems}
			>
				{m.workers_import_download_problems()}
			</Button>
		</div>
	{/if}

	<div class="max-w-full overflow-x-auto rounded-md border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head>{m.workers_import_table_csv_row()}</Table.Head>
					<Table.Head>{m.workers_import_table_name()}</Table.Head>
					<Table.Head>{m.workers_import_table_phone()}</Table.Head>
					<Table.Head>{m.workers_import_table_email()}</Table.Head>
					{#if showAttributes}
						<Table.Head>{m.workers_import_table_attributes()}</Table.Head>
					{/if}
					<Table.Head>{m.workers_import_table_status()}</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each view.rows as row (row.rowNumber)}
					<Table.Row data-csv-row={row.rowNumber} data-disposition={row.disposition}>
						<Table.Cell class="num">{row.rowNumber}</Table.Cell>
						<Table.Cell>{row.name || '—'}</Table.Cell>
						<Table.Cell class="num">
							{#if row.phoneProblem}
								<span class="inline-flex items-center gap-1.5">
									<AlertCircleIcon class="size-4 shrink-0 text-destructive" aria-hidden="true" />
									<span class="text-muted-foreground">{row.phone}</span>
									<span class="text-destructive">{m.workers_import_not_ten_digits()}</span>
								</span>
							{:else}
								{row.phone || '—'}
							{/if}
						</Table.Cell>
						<Table.Cell>{row.email || '—'}</Table.Cell>
						{#if showAttributes}
							<Table.Cell>
								{#each answersLine(row) as line (line)}
									<p>{line}</p>
								{:else}
									—
								{/each}
								{#each row.attributes as entry (entry.attributeId)}
									{#each entry.reading.emptyPositions as position (position)}
										<p class="text-muted-foreground">
											{m.workers_import_attribute_empty_entry({
												attribute: attributeName(entry.attributeId),
												position
											})}
										</p>
									{/each}
								{/each}
							</Table.Cell>
						{/if}
						<Table.Cell>
							{#if !row.valid}
								{m.workers_import_status_skipped()}
							{:else if row.disposition === 'skip'}
								{m.workers_import_status_skipped_choice()}
							{:else if row.disposition === 'undecided'}
								{m.workers_import_status_undecided()}
							{:else if row.disposition === 'blank-phone'}
								{m.workers_import_status_phone()}
							{:else if row.decisions.attribute === 'omit'}
								{m.workers_import_status_left_out()}
							{:else}
								{m.workers_import_status_ready()}
							{/if}
							{#if row.valid}
								{@const cellProblems = row.attributes.flatMap((entry) =>
									entry.reading.problems.map((problem) => ({
										attributeId: entry.attributeId,
										problem
									}))
								)}
								{#if cellProblems.length > 0}
									<ul class="mt-1 grid gap-0.5 text-xs text-destructive">
										{#each cellProblems as { attributeId, problem } (`${attributeId}:${problem.code}:${problem.position ?? ''}:${problem.text ?? ''}`)}
											<li>{cellProblemLine(attributeId, problem)}</li>
										{/each}
									</ul>
									<div class="mt-1 flex flex-wrap gap-1.5">
										{#each [['omit', m.workers_import_leave_out()], ['skip', m.workers_import_skip_row()]] as const as [decision, label] (decision)}
											<Button
												type="button"
												size="sm"
												variant={row.decisions.attribute === decision ? 'secondary' : 'outline'}
												class="min-h-tap md:min-h-8"
												aria-pressed={row.decisions.attribute === decision}
												aria-label={m.workers_import_action_row({
													action: label,
													row: row.rowNumber
												})}
												onclick={() => onDecideAttribute(row.rowNumber, decision)}
											>
												{label}
											</Button>
										{/each}
									</div>
								{/if}
								{#if row.duplicates.length > 0}
									<ul class="mt-1 grid gap-0.5 text-xs">
										{#each row.duplicates as duplicate (duplicate.workerId)}
											<li>
												{m.workers_import_duplicate_match({
													worker: duplicate.workerName,
													reasons: formatList(
														duplicate.reasons.map((reason) => reasonLabels[reason]())
													)
												})}
											</li>
										{/each}
									</ul>
									<div class="mt-1 flex flex-wrap gap-1.5">
										{#each [['skip', m.workers_import_skip_row()], ['create', m.workers_import_create_separate()]] as const as [decision, label] (decision)}
											<Button
												type="button"
												size="sm"
												variant={row.decisions.duplicate === decision ? 'secondary' : 'outline'}
												class="min-h-tap md:min-h-8"
												aria-pressed={row.decisions.duplicate === decision}
												aria-label={m.workers_import_action_row({
													action: label,
													row: row.rowNumber
												})}
												onclick={() => onDecideDuplicate(row.rowNumber, decision)}
											>
												{label}
											</Button>
										{/each}
									</div>
								{/if}
							{/if}
						</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={showAttributes ? 6 : 5} class="text-center">
							{columns.name < 0 ? m.workers_import_empty_preview() : m.workers_import_no_problems()}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
	{#if view.pageCount > 1}
		<div class="flex items-center justify-between gap-2">
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="min-h-tap md:min-h-8"
				disabled={view.page <= 1}
				onclick={() => onPage(view.page - 1)}
			>
				{m.workers_import_page_previous()}
			</Button>
			<p class="text-sm text-muted-foreground" role="status">
				{m.workers_import_page({ page: view.page, pages: view.pageCount })}
			</p>
			<Button
				type="button"
				size="sm"
				variant="outline"
				class="min-h-tap md:min-h-8"
				disabled={view.page >= view.pageCount}
				onclick={() => onPage(view.page + 1)}
			>
				{m.workers_import_page_next()}
			</Button>
		</div>
	{/if}
</div>
