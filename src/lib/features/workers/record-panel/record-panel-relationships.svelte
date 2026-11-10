<script lang="ts">
	/**
	 * Relationships as chips: the other Worker's Assessment dot and name. The chip
	 * opens that Worker's record; its inline × takes the pair off both records at
	 * once, because a Relationship is one normalized pair. Removal reports through
	 * the status line, whose Undo puts the pair back.
	 */
	import { tick } from 'svelte';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { relationshipCandidates } from './relationship-candidates.ts';
	import SwatchDot from '#lib/shared/swatch-dot.svelte';
	import { assessmentColorKey } from '#lib/shared/assessment.ts';
	import { runSingleEdit } from '../data-table/data-table-bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { assessmentLabel } from '#lib/i18n/assessment.ts';

	let {
		worker,
		workers,
		attributes,
		headingId,
		onSelectWorker,
		onShowOnMapping,
		onAddRelationship,
		onRemoveRelationship,
		refresh,
		onSaved
	}: {
		worker: Worker;
		workers: Worker[];
		attributes: readonly WorkerAttributeDefinition[];
		headingId: string;
		onSelectWorker?: (workerId: string) => void;
		/** Opens this Worker on the Mapping. */
		onShowOnMapping?: (workerId: string) => void;
		/** Puts one pair back, which is what a removal's Undo sends. */
		onAddRelationship: (workerId: string, otherWorkerId: string) => Promise<void>;
		/** Takes one pair off both records. */
		onRemoveRelationship: (workerId: string, otherWorkerId: string) => Promise<void>;
		refresh: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
	} = $props();

	let heading = $state<HTMLHeadingElement | null>(null);
	/** The pair whose removal is in flight, so its own chip cannot be pressed twice. */
	let removing = $state<string | null>(null);

	let adding = $state(false);
	let query = $state('');
	let saving = $state(false);
	let search = $state<HTMLInputElement | null>(null);
	let openButton = $state<HTMLButtonElement | null>(null);

	// The list belongs to one record: another Worker starts with it closed.
	$effect(() => {
		void worker.id;
		adding = false;
		query = '';
	});

	const candidates = $derived(
		adding ? relationshipCandidates(worker, workers, attributes, query) : null
	);

	async function openList() {
		adding = true;
		await tick();
		search?.focus();
	}

	async function closeList() {
		adding = false;
		query = '';
		await tick();
		openButton?.focus();
	}

	async function add(other: Worker) {
		if (saving) return;

		// Both ids and the names are read now, for the same reason as in `remove`.
		const workerId = worker.id;
		const otherWorkerId = other.id;
		const summary = m.workers_relationship_added({ worker: worker.name, other: other.name });
		const addPair = onAddRelationship;
		const removePair = onRemoveRelationship;

		saving = true;
		const report = await runSingleEdit({
			apply: () => addPair(workerId, otherWorkerId),
			restore: () => removePair(workerId, otherWorkerId),
			refresh,
			summary,
			fallback: m.workers_relationship_add_failed()
		});
		saving = false;
		onSaved?.(report);

		// A refused add keeps the list open so the organizer can try again.
		if (!report.error) await closeList();
	}

	const related = $derived(
		worker.relationships
			.map((id) => workers.find((candidate) => candidate.id === id))
			.filter((other): other is Worker => other !== undefined)
	);

	async function remove(other: Worker) {
		if (removing !== null) return;

		// Both ids are read now: the selection can move before the status line's
		// Undo runs, and that Undo must still name the pair it is putting back.
		const workerId = worker.id;
		const otherWorkerId = other.id;

		removing = otherWorkerId;
		const report = await runSingleEdit({
			apply: () => onRemoveRelationship(workerId, otherWorkerId),
			restore: () => onAddRelationship(workerId, otherWorkerId),
			refresh,
			summary: m.workers_relationship_removed({ worker: worker.name, other: other.name }),
			fallback: m.workers_relationship_remove_failed()
		});
		removing = null;
		onSaved?.(report);

		// The × that was just pressed is gone with the chip, so focus moves up.
		if (!report.error) heading?.focus();
	}
</script>

<section aria-labelledby={headingId} class="grid grid-cols-[minmax(0,1fr)] gap-3">
	<div class="flex items-center justify-between gap-2">
		<h3 id={headingId} bind:this={heading} tabindex="-1" class="label">
			{m.workers_relationships_heading()}
		</h3>
		{#if related.length}
			<span class="num text-xs text-ink-3" data-testid="relationship-count">
				{m.workers_relationships_count({ count: related.length })}
			</span>
		{/if}
	</div>
	{#if related.length}
		<ul class="flex flex-wrap gap-2">
			{#each related as other (other.id)}
				<li class="flex h-7 max-w-full items-center rounded-item bg-inset text-sm">
					<!-- Kept raw: the left half of a split chip, joined to its remove control. -->
					<button
						type="button"
						class="flex h-full min-w-0 items-center gap-1.5 rounded-l-item pr-1 pl-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
						aria-label={m.workers_relationship_chip({
							name: other.name,
							assessment: assessmentLabel(other.assessment)
						})}
						onclick={() => onSelectWorker?.(other.id)}
					>
						<SwatchDot color={`var(--${assessmentColorKey(other.assessment)})`} />
						<span class="prose-value min-w-0 truncate" title={other.name}>{other.name}</span>
					</button>
					<!-- Kept raw: the right half of a split chip, joined to the worker button. -->
					<button
						type="button"
						class="flex h-full shrink-0 items-center rounded-r-item px-1.5 text-ink-3 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
						aria-label={m.workers_relationship_remove({ name: other.name })}
						disabled={removing !== null}
						onclick={() => void remove(other)}
					>
						<XIcon class="size-3.5" />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if candidates}
		<!-- A list inside the section, not a floating popover. -->
		<div class="grid grid-cols-[minmax(0,1fr)] gap-2 rounded-item bg-inset p-2">
			<Input
				bind:ref={search}
				bind:value={query}
				type="search"
				placeholder={m.workers_relationship_search()}
				aria-label={m.workers_relationship_search_aria()}
				disabled={saving}
				onkeydown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						void closeList();
					}
				}}
			/>
			{#if candidates.matches.length}
				<ul
					aria-label={m.workers_relationship_list_aria()}
					class="grid max-h-56 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-y-auto overscroll-contain pb-1"
				>
					{#each candidates.matches as { worker: candidate, detail } (candidate.id)}
						<li>
							<!-- Kept raw: a full-width candidate row with a swatch, not a button variant. -->
							<button
								type="button"
								class="flex min-h-tap w-full items-center gap-2 rounded-item px-2 py-1 text-left text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60 lg:min-h-8"
								aria-label={detail
									? `${m.workers_relationship_chip({ name: candidate.name, assessment: assessmentLabel(candidate.assessment) })}, ${detail}`
									: m.workers_relationship_chip({
											name: candidate.name,
											assessment: assessmentLabel(candidate.assessment)
										})}
								disabled={saving}
								onclick={() => void add(candidate)}
							>
								<SwatchDot color={`var(--${assessmentColorKey(candidate.assessment)})`} />
								<span class="prose-value min-w-0 flex-1 truncate" title={candidate.name}
									>{candidate.name}</span
								>
								{#if detail}
									<span class="shrink-0 text-xs text-ink-3">{detail}</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="px-2 text-sm text-ink-3">
					{query.trim() ? m.workers_relationship_no_match() : m.workers_relationship_none()}
				</p>
			{/if}
			<!-- The footer sits below the scrolling list, never over it. -->
			<div class="flex items-center justify-between gap-2 border-t border-rule pt-2">
				{#if candidates.more}
					<p class="min-w-0 px-2 text-xs text-ink-3">{m.workers_relationship_narrow()}</p>
				{/if}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="ml-auto min-h-tap lg:min-h-8"
					onclick={() => void closeList()}
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
			bind:ref={openButton}
			onclick={() => void openList()}
		>
			<PlusIcon class="size-4" />
			{m.workers_relationship_add()}
		</Button>
	{/if}
	{#if related.length && onShowOnMapping}
		<Button
			type="button"
			variant="ghost"
			size="sm"
			class="min-h-tap justify-self-start lg:min-h-8"
			onclick={() => onShowOnMapping(worker.id)}
		>
			{m.workers_relationships_mapping()}
		</Button>
	{/if}
</section>
