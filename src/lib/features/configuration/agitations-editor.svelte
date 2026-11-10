<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { Agitation, Worker } from '#lib/domain-vocabulary.ts';
	import { countValueHolders } from '#lib/shared/worker-population.ts';
	import ListFoldHeading from './list-fold-heading.svelte';
	import OutlineCount from './outline-count.svelte';
	import EditableChip from './editable-chip.svelte';
	import MergeConfirmDialog from './merge-confirm-dialog.svelte';
	import type { ValueTextCheck } from './configuration-draft.ts';

	type Props = {
		agitations: Agitation[];
		/** The draft's whole list, folded entries included, so holders follow a merge. */
		allAgitations: readonly { id: string; mergedInto?: string }[];
		workers: readonly Worker[];
		newAgitationText?: string;
		error: string;
		saving: boolean;
		onInput: () => void;
		onSubmit: (event: SubmitEvent) => void;
		onRemove: (id: string) => void;
		onRename: (id: string, text: string) => ValueTextCheck;
		onMerge: (foldedId: string, survivorId: string) => void;
	};

	let {
		agitations,
		allAgitations,
		workers,
		newAgitationText = $bindable(''),
		error,
		saving,
		onInput,
		onSubmit,
		onRemove,
		onRename,
		onMerge
	}: Props = $props();

	let open = $state(true);
	const bodyId = $props.id();
	const holders = $derived(countValueHolders(workers, 'agitations', allAgitations));

	/** A duplicate edit waiting for confirmation: the folded chip, its text, and the survivor. */
	let pendingMerge = $state<{ foldedId: string; foldingText: string; survivorId: string } | null>(
		null
	);
	const pendingSurvivorText = $derived(
		agitations.find((agitation) => agitation.id === pendingMerge?.survivorId)?.text ?? ''
	);
</script>

<!--
  Agitations section.
  Its own card beside Languages. The card is the panel step, the well inside it is
  the recess step and the chips take the panel step back, so the field reads as a
  well of named things rather than as a row of buttons on the page. Only the title
  pins while the card scrolls; the description scrolls away with the list, so the
  pinned band stays one line tall.
-->
<div class="grid gap-2" data-testid="agitations-section">
	<ListFoldHeading
		title={m.domain_agitations()}
		{open}
		controls={bodyId}
		holders={holders.workersWithAny}
		onToggle={() => (open = !open)}
	/>
	{#if open}
		<div id={bodyId} class="grid gap-2">
			<Field.Description>{m.configuration_agitations_description()}</Field.Description>
			<form
				class="mt-2 flex flex-wrap items-center gap-2 rounded-surface bg-inset p-2"
				onsubmit={onSubmit}
			>
				{#each agitations as agitation (agitation.id)}
					<span class="inline-flex items-center gap-1">
						<EditableChip
							text={agitation.text}
							editLabel={m.configuration_edit_value({ name: agitation.text })}
							removeLabel={m.configuration_remove_value({ name: agitation.text })}
							surface="pad"
							disabled={saving}
							onRemove={() => onRemove(agitation.id)}
							onRename={(text) => onRename(agitation.id, text)}
							onDuplicate={(text, survivorId) =>
								(pendingMerge = { foldedId: agitation.id, foldingText: text, survivorId })}
						/>
						<OutlineCount testId="list-worker-count" count={holders.byId.get(agitation.id) ?? 0} />
					</span>
				{/each}
				<!-- The well is the boundary, so the field keeps its own focus ring and
		     gives up only its box: a caret you cannot find is a broken form. -->
				<Input
					bind:value={newAgitationText}
					placeholder={agitations.length
						? m.configuration_add_another()
						: m.configuration_add_agitation()}
					class="min-h-tap min-w-0 grow basis-64 border-0 bg-transparent px-2 shadow-none md:min-h-(--control-h)"
					aria-label={m.configuration_add_agitation()}
					aria-invalid={Boolean(error)}
					aria-describedby={error ? 'agitation-error' : undefined}
					disabled={saving}
					oninput={onInput}
					onkeydown={(event) => {
						if (event.key === 'Backspace' && !newAgitationText && agitations.length) {
							onRemove(agitations[agitations.length - 1].id);
						}
					}}
				/>
				<!-- Held while empty, so typing never wraps a new row into the well.
		     Default-size, so the section's one action speaks at the body step. -->
				<Button
					type="submit"
					variant="outline"
					class="min-h-tap md:min-h-(--control-h)"
					disabled={saving || !newAgitationText.trim()}
				>
					{m.common_add()}
				</Button>
			</form>
			{#if error}
				<p id="agitation-error" class="text-sm text-state-error" role="alert">
					{error}
				</p>
			{/if}
		</div>
	{/if}
</div>

<MergeConfirmDialog
	open={pendingMerge !== null}
	foldingText={pendingMerge?.foldingText ?? ''}
	survivorText={pendingSurvivorText}
	onConfirm={() => {
		if (pendingMerge) onMerge(pendingMerge.foldedId, pendingMerge.survivorId);
		pendingMerge = null;
	}}
	onCancel={() => (pendingMerge = null)}
/>
