<script lang="ts">
	/**
	 * Agitations as chips, in the same style as Relationships. A chip's inline ×
	 * unassigns the Agitation from this Worker only: the worksite's Agitation and
	 * other Workers' assignments stay (ADR-0004). Removal reports through the
	 * status line, whose Undo assigns it again.
	 *
	 * Add Agitation opens the same inline panel as Add Relationship: a search box, a
	 * top row that creates an Agitation from the typed text, and the worksite's
	 * Agitations this Worker does not hold yet.
	 */
	import { tick } from 'svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { getEditModel } from '#lib/features/workers/edit-model.svelte.ts';
	import { runSingleEdit } from '../data-table/data-table-bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import { agitationCandidates } from './agitation-candidates.ts';
	import type { Agitation, Worker } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';

	let {
		worker,
		agitations,
		headingId,
		onAssignAgitation,
		onUnassignAgitation,
		onCreateAgitation,
		refresh,
		onSaved
	}: {
		worker: Worker;
		agitations: readonly Agitation[];
		headingId: string;
		/** Bound to this Worker by the panel: links one Agitation, which a removal's Undo sends. */
		onAssignAgitation: (agitationId: string) => Promise<void>;
		/** Bound to this Worker by the panel: unlinks one Agitation. */
		onUnassignAgitation: (agitationId: string) => Promise<void>;
		/** Creates a worksite Agitation or returns its matching text. */
		onCreateAgitation: (text: string) => Promise<Agitation>;
		refresh: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
	} = $props();

	let heading = $state<HTMLHeadingElement | null>(null);
	let adding = $state(false);
	let query = $state('');
	let saving = $state(false);
	let addedNotice = $state(false);
	let errorMessage = $state('');
	let search = $state<HTMLInputElement | null>(null);
	let addButton = $state<HTMLButtonElement | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	const editModel = getEditModel();
	/** The Agitation whose removal is in flight, so its chip cannot be pressed twice. */
	let removing = $state<string | null>(null);

	// The list belongs to one record: another Worker starts with it closed.
	$effect(() => {
		void worker.id;
		adding = false;
		query = '';
	});

	const texts = $derived(
		worker.agitations
			.map((id) => agitations.find((agitation) => agitation.id === id))
			.filter((agitation): agitation is Agitation => agitation !== undefined)
	);

	const candidates = $derived(adding ? agitationCandidates(worker, agitations, query) : null);

	function resetNoticeTimer() {
		clearTimeout(noticeTimer);
		addedNotice = true;
		noticeTimer = setTimeout(() => (addedNotice = false), 4000);
	}

	async function openAdder() {
		adding = true;
		await tick();
		search?.focus();
	}

	async function closeAdder() {
		if (saving) return;
		adding = false;
		query = '';
		await tick();
		addButton?.focus();
	}

	/**
	 * Assigns a chosen Agitation, or creates one from the typed text (or uses the
	 * existing Agitation the text names) and assigns that. Create and assign are one
	 * undoable edit. A refused add keeps the panel open with the retry message.
	 */
	async function addAgitation(chosen?: Agitation): Promise<boolean> {
		if (saving) return false;
		const text = query.trim();
		const existing = chosen ?? agitationCandidates(worker, agitations, text).exact;
		if (!existing && !text) return false;
		if (existing && worker.agitations.includes(existing.id)) {
			await closeAdder();
			return true;
		}

		let agitationId: string | null = existing?.id ?? null;
		const created = existing === undefined;
		const assign = onAssignAgitation;
		const unassign = onUnassignAgitation;
		const create = onCreateAgitation;
		const summary = m.workers_agitation_added({ worker: worker.name });
		saving = true;
		errorMessage = '';
		const report = await runSingleEdit({
			apply: async () => {
				const agitation = existing ?? (await create(text));
				agitationId = agitation.id;
				if (!worker.agitations.includes(agitation.id)) await assign(agitation.id);
			},
			restore: () => (agitationId ? unassign(agitationId) : Promise.resolve()),
			refresh,
			summary,
			fallback: m.workers_agitation_add_failed()
		});
		saving = false;
		if (report.error) {
			errorMessage = m.workers_agitation_add_failed_retry();
			return false;
		}

		if (created) resetNoticeTimer();
		onSaved?.(report);
		await closeAdder();
		return true;
	}

	$effect(() => {
		if (!adding || !query.trim()) return;
		return editModel.registerDraft(() => addAgitation());
	});

	$effect(() => () => clearTimeout(noticeTimer));

	async function remove(agitation: Agitation) {
		if (removing !== null) return;

		// Name, id and callbacks are read now: the selection can move before the
		// status line's Undo runs, and that Undo must still name the Worker it started on.
		const workerName = worker.name;
		const agitationId = agitation.id;
		const assign = onAssignAgitation;
		const unassign = onUnassignAgitation;

		removing = agitationId;
		const report = await runSingleEdit({
			apply: () => unassign(agitationId),
			restore: () => assign(agitationId),
			refresh,
			summary: m.workers_agitation_removed({ worker: workerName }),
			fallback: m.workers_agitation_remove_failed()
		});
		removing = null;
		onSaved?.(report);

		// The × that was just pressed is gone with the chip, so focus moves up.
		if (!report.error) heading?.focus();
	}
</script>

<section aria-labelledby={headingId} class="grid grid-cols-[minmax(0,1fr)] gap-3">
	<h3 id={headingId} bind:this={heading} tabindex="-1" class="label">
		{m.workers_agitations_heading()}
	</h3>
	{#if texts.length}
		<ul class="flex flex-wrap gap-2">
			{#each texts as agitation (agitation.id)}
				<li class="flex h-7 max-w-full items-center rounded-item bg-inset text-sm">
					<span class="prose-value min-w-0 truncate pr-1 pl-2" title={agitation.text}
						>{agitation.text}</span
					>
					<!-- Kept raw: the remove control is joined to the chip's right edge; the ui Button's radius and border break that join. -->
					<button
						type="button"
						class="flex h-full shrink-0 items-center rounded-r-item px-1.5 text-ink-3 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
						aria-label={m.workers_agitation_remove({ text: agitation.text })}
						disabled={removing !== null}
						onclick={() => void remove(agitation)}
					>
						<XIcon class="size-3.5" />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if candidates}
		<!-- A panel inside the section, not a floating popover, as Relationships. -->
		<div class="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-item bg-inset p-2">
			<Input
				bind:ref={search}
				bind:value={query}
				type="search"
				aria-label={m.workers_agitation_input()}
				placeholder={m.workers_agitation_search()}
				disabled={saving}
				oninput={() => (errorMessage = '')}
				onkeydown={(event) => {
					if (event.isComposing) return;
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						void closeAdder();
					} else if (event.key === 'Enter') {
						event.preventDefault();
						void addAgitation();
					}
				}}
			/>
			{#if !candidates.exact}
				<!-- Kept raw: a full-width row with the add text, not a button variant. -->
				<button
					type="button"
					class="flex min-h-tap w-full items-center rounded-item px-2 py-1 text-left text-sm text-ink-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring disabled:text-ink-3 disabled:opacity-60 lg:min-h-8"
					disabled={saving || !query.trim()}
					onclick={() => void addAgitation()}
				>
					{query.trim()
						? m.workers_agitation_new({ text: query.trim() })
						: m.workers_agitation_new_hint()}
				</button>
			{/if}
			{#if candidates.matches.length}
				<ul
					aria-label={m.workers_agitation_list_aria()}
					class="grid max-h-56 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-y-auto overscroll-contain pb-1"
				>
					{#each candidates.matches as agitation (agitation.id)}
						<li>
							<!-- Kept raw: a full-width candidate row, not a button variant. -->
							<button
								type="button"
								class="flex min-h-tap w-full items-center rounded-item px-2 py-1 text-left text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 lg:min-h-8"
								disabled={saving}
								onclick={() => void addAgitation(agitation)}
							>
								<span class="prose-value min-w-0 flex-1 truncate" title={agitation.text}
									>{agitation.text}</span
								>
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="px-2 text-sm text-ink-3">
					{query.trim() ? m.workers_agitation_no_match() : m.workers_agitation_none()}
				</p>
			{/if}
			{#if errorMessage}
				<p role="alert" class="text-sm text-state-error">{errorMessage}</p>
			{/if}
			<!-- The footer sits below the scrolling list, never over it. -->
			<div class="flex items-center justify-end gap-2 border-t border-rule pt-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="min-h-tap lg:min-h-8"
					onclick={() => void closeAdder()}
				>
					{m.common_done()}
				</Button>
			</div>
		</div>
	{:else}
		<Button
			type="button"
			variant="ghost"
			size="sm"
			class="min-h-tap justify-self-start lg:min-h-8"
			bind:ref={addButton}
			onclick={() => void openAdder()}
		>
			<PlusIcon class="size-4" />
			{m.workers_agitation_add()}
		</Button>
	{/if}
	<!-- Below the section content, not tied to the panel: it outlives the panel's close. -->
	{#if addedNotice}
		<p class="text-xs text-muted-foreground">{m.workers_agitation_added_notice()}</p>
	{/if}
	<p class="sr-only" aria-live="polite" aria-atomic="true">
		{addedNotice ? m.workers_agitation_added_notice() : ''}
	</p>
</section>
