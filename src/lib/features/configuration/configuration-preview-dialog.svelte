<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import ChoiceSelect from '#lib/shared/choice-select.svelte';
	import { createFocusReturn } from './focus-return.svelte.ts';
	import { workerImpact, type WorkerImpactState } from './worker-impact.ts';
	import type {
		PreviewHolderChoice,
		PreviewHolderRow,
		PreviewResolutionGroup,
		PreviewSummaryRow
	} from './configuration-preview.ts';

	type Props = {
		open: boolean;
		rows: PreviewSummaryRow[];
		/** The deduplicated overall effect, already phrased. */
		summary: string;
		/** Actual loss needs a deliberate confirmation; a harmless change does not. */
		requiresConfirmation: boolean;
		/** Whether the actual loss is of shared values rather than Attribute answers. */
		sharedLoss: boolean;
		/** Every removed leaf answer and the holders it affects. */
		resolutionGroups: PreviewResolutionGroup[];
		/** Whether every affected holder has its explicit resolution. */
		resolutionsComplete: boolean;
		onConfirm: () => void;
		onCancel: () => void;
		onChoose: (key: string, choice: PreviewHolderChoice) => void;
	};

	let {
		open,
		rows,
		summary,
		requiresConfirmation,
		sharedLoss,
		resolutionGroups,
		resolutionsComplete,
		onConfirm,
		onCancel,
		onChoose
	}: Props = $props();

	const returnFocus = createFocusReturn(() => open);

	const impact = $derived(workerImpact(resolutionGroups));

	function impactStateLabel(state: WorkerImpactState): string {
		if (state === 'retained') return m.configuration_impact_state_retained();
		if (state === 'removed') return m.configuration_impact_state_removed();
		return m.configuration_impact_state_unresolved();
	}

	const destructiveLabel = $derived(
		sharedLoss
			? m.configuration_preview_action_discard_shared()
			: m.configuration_preview_action_discard()
	);

	/** An Attribute-only preview names Attribute changes; anything else is Configuration. */
	const attributeOnly = $derived(
		rows.length > 0 && rows.every((row) => row.key.startsWith('attribute:'))
	);
	const title = $derived(
		requiresConfirmation
			? sharedLoss
				? m.configuration_preview_title_loss_shared()
				: m.configuration_preview_title_loss()
			: attributeOnly
				? m.configuration_preview_title_attributes()
				: m.configuration_preview_title_configuration()
	);

	function selectedValue(row: PreviewHolderRow): string {
		if (row.choice.replacement === undefined) return '';
		if (row.choice.replacement === null) return '__none__';
		return row.choice.replacement;
	}

	function holderKindLabel(row: PreviewHolderRow): string {
		if (row.kind === 'worker') return m.configuration_cardinality_worker_value();
		const surface = row.surface ?? row.cardinalitySurface;
		if (surface === 'base') return m.configuration_cardinality_draft_base();
		if (surface === 'draft') return m.configuration_cardinality_draft_update();
		return m.configuration_preview_kind_worker_draft();
	}

	function holderResolutionLabel(row: PreviewHolderRow): string {
		return m.configuration_preview_resolution_aria({
			worker: row.workerName,
			holder: holderKindLabel(row)
		});
	}

	function cardinalitySurfaceLabel(surface: NonNullable<PreviewHolderRow['cardinalitySurface']>) {
		if (surface === 'base') return m.configuration_cardinality_surface_draft_base();
		if (surface === 'draft') return m.configuration_cardinality_surface_draft_update();
		return m.configuration_cardinality_surface_value();
	}

	function chooseReplacement(row: PreviewHolderRow, value: string) {
		if (value === '') onChoose(row.key, {});
		else if (value === '__none__') onChoose(row.key, { replacement: null });
		else onChoose(row.key, { replacement: value });
	}

	/** A group of plain replacements can take one resolution for every holder at once. */
	function canApplyToAll(group: PreviewResolutionGroup): boolean {
		return (
			group.rows.length > 1 &&
			!group.mergeInto &&
			group.rows.every(
				(row) => !row.attributeRemoval && !row.cardinalitySurface && !row.acknowledgement
			)
		);
	}

	/** Re-keys a group's apply-to-all select so it returns to its prompt after applying. */
	let appliedCount = $state<Record<string, number>>({});

	function applyToAll(group: PreviewResolutionGroup, value: string) {
		appliedCount[group.key] = (appliedCount[group.key] ?? 0) + 1;
		if (value === '') return;
		for (const row of group.rows) {
			if (value === '__none__') {
				onChoose(row.key, { replacement: null });
			} else if (row.replacements.some((candidate) => candidate.answerId === value)) {
				onChoose(row.key, { replacement: value });
			}
		}
	}

	function selectedRetained(row: PreviewHolderRow): string {
		const retained = row.choice.retained;
		if (retained === undefined) return '';
		if (retained === null) return '__none__';
		return retained;
	}

	function chooseRetained(row: PreviewHolderRow, value: string) {
		if (value === '') onChoose(row.key, {});
		else if (value === '__none__') onChoose(row.key, { retained: null });
		else onChoose(row.key, { retained: value });
	}
</script>

<!--
  The staged Configuration effect at Save all.
  It reads what the core preview reported, with labels resolved from the stable ids: a
  removal states the definition loss, a merge states preservation, a conversion states
  that every affected Worker value, draft update and draft base keeps the answer chosen here. A removed leaf
  answer also names every affected saved value and draft surface, and the organizer
  resolves each one explicitly; only actual loss turns the action destructive.
-->
<AlertDialog.Root
	{open}
	onOpenChange={(next) => {
		if (!next) onCancel();
	}}
>
	<AlertDialog.Content
		data-testid="configuration-preview-dialog"
		onCloseAutoFocus={returnFocus}
		class="max-h-[calc(100dvh-2rem)] overflow-y-auto"
	>
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			<AlertDialog.Description>{summary}</AlertDialog.Description>
		</AlertDialog.Header>

		<ul class="grid gap-2" aria-label={m.configuration_preview_changes_aria()}>
			{#each rows as row (row.key)}
				<li class="grid gap-0.5 rounded-item bg-inset p-2" data-preview-change={row.key}>
					<span class="text-sm font-medium">{row.title}</span>
					<span class="text-sm text-ink-2">{row.detail}</span>
				</li>
			{/each}
		</ul>

		{#if impact.length > 0}
			<ul class="grid gap-2" aria-label={m.configuration_impact_aria()} data-testid="worker-impact">
				{#each impact as worker (worker.workerId)}
					<li class="grid gap-0.5 rounded-item bg-inset p-2" data-impact-worker={worker.workerId}>
						<span class="text-sm font-medium">{worker.workerName}</span>
						{#each worker.rows as row (row.key)}
							<span class="text-sm text-ink-2" data-impact-state={row.state}>
								{impactStateLabel(row.state)}:
								{row.state === 'unresolved'
									? m.configuration_impact_unresolved({ before: row.before })
									: m.configuration_impact_before_after({ before: row.before, after: row.after })}
							</span>
						{/each}
					</li>
				{/each}
			</ul>
		{/if}

		{#if resolutionGroups.length > 0}
			<div class="grid gap-3" data-testid="configuration-resolutions">
				<p class="text-sm font-medium">{m.configuration_preview_resolve_heading()}</p>
				{#each resolutionGroups as group (group.key)}
					<section class="grid gap-2" aria-label={group.title}>
						<h3 class="text-sm font-medium">{group.title}</h3>
						<p class="text-sm text-ink-2">{group.detail}</p>
						{#if canApplyToAll(group)}
							{#key appliedCount[group.key] ?? 0}
								<ChoiceSelect
									aria-label={m.configuration_preview_apply_all_aria({ count: group.rows.length })}
									data-testid="configuration-apply-to-all"
									placeholder={m.configuration_preview_apply_all({ count: group.rows.length })}
									items={[
										...group.rows[0].replacements.map((replacement) => ({
											value: replacement.answerId,
											label: m.configuration_preview_replace_with({ answer: replacement.label })
										})),
										{ value: '__none__', label: m.configuration_cardinality_no_answer() }
									]}
									onChange={(next) => applyToAll(group, next)}
								/>
							{/key}
						{/if}
						<ul class="grid gap-2">
							{#each group.rows as holder (holder.key)}
								<li
									class="grid gap-1 rounded-item border border-rule p-2"
									data-resolution-holder={holder.key}
									data-holder-kind={holder.kind}
								>
									<span class="text-sm font-medium">
										{m.configuration_preview_holder_name({
											worker: holder.workerName,
											kind: holderKindLabel(holder)
										})}
									</span>
									<span class="text-sm text-ink-2">{holder.summary}</span>
									{#if holder.keeps}
										<span class="text-sm text-ink-2">{holder.keeps}</span>
									{/if}
									{#if holder.attributeRemoval}
										<p class="text-sm text-ink-2">
											{m.configuration_preview_attribute_removal({
												name: holder.attributeName ?? ''
											})}
										</p>
									{:else if holder.cardinalitySurface}
										<ChoiceSelect
											aria-label={m.configuration_cardinality_retained_aria({
												worker: holder.workerName,
												surface: cardinalitySurfaceLabel(holder.cardinalitySurface)
											})}
											placeholder={m.configuration_cardinality_choose_answer()}
											items={[
												...(holder.heldAnswers ?? []).map((answer) => ({
													value: answer.answerId,
													label: m.configuration_cardinality_keep_answer({ answer: answer.label })
												})),
												{ value: '__none__', label: m.configuration_cardinality_no_answer() }
											]}
											value={selectedRetained(holder)}
											onChange={(next) => chooseRetained(holder, next)}
										/>
									{:else if !holder.acknowledgement}
										<ChoiceSelect
											aria-label={holderResolutionLabel(holder)}
											placeholder={m.configuration_preview_choose_resolution()}
											items={group.mergeInto
												? holder.replacements.map((replacement) => ({
														value: replacement.answerId,
														label: m.configuration_preview_follow_merge({
															answer: replacement.label
														})
													}))
												: [
														...holder.replacements.map((replacement) => ({
															value: replacement.answerId,
															label: m.configuration_preview_replace_with({
																answer: replacement.label
															})
														})),
														{
															value: '__none__',
															label: m.configuration_cardinality_no_answer()
														}
													]}
											value={selectedValue(holder)}
											onChange={(next) => chooseReplacement(holder, next)}
										/>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			</div>
		{/if}

		{#if requiresConfirmation}
			<p class="text-sm text-state-error">{m.configuration_preview_irreversible()}</p>
		{/if}

		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action
				variant={requiresConfirmation ? 'destructive' : 'default'}
				class={requiresConfirmation
					? 'bg-destructive text-on-action hover:bg-destructive/90'
					: undefined}
				disabled={!resolutionsComplete}
				onclick={onConfirm}
			>
				{requiresConfirmation ? destructiveLabel : m.configuration_preview_action_save()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
