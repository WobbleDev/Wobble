<script lang="ts">
	/**
	 * One ordinary Attribute in the record panel: its label, the current reading, and
	 * an editor opened where the reading is shown. Single-Select holds one answer or
	 * none; Multi-Select holds several distinct answers or none. Answers save one
	 * Attribute through `PATCH /api/workers/:id` and report through the status line,
	 * with Undo. An open editor's choices are part of the Worker draft (ADR-0023), so
	 * moving off the record keeps them and coming back reopens them.
	 *
	 * New Worker uses the same row in `pending` mode: Save updates the choices the
	 * create request will send, rather than writing a record that does not exist yet.
	 */
	import { onMount, tick } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { cn } from '#lib/utils.ts';
	import { pickAnswer, storesList } from '#lib/shared/select-mode.ts';
	import type {
		Worker,
		WorkerAttributeDefinition,
		WorkerAttributeValue
	} from '#lib/domain-vocabulary.ts';
	import { answerChoices, describeAnswerValue, heldAnswerIds } from '../answers.ts';
	import { runSingleEdit } from '../data-table/data-table-bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { copyAttributeValue, sameAttributeValue } from './panel-draft.ts';
	import { getPanelDraft } from './panel-draft-state.svelte.ts';

	type Props = {
		worker: Worker;
		attribute: WorkerAttributeDefinition;
		/** `saved` writes the record; `pending` (New Worker) holds the choice to create with. */
		mode?: 'saved' | 'pending';
		/** Reloads the Workers table once a saved write has landed. */
		refresh?: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
		/** `pending` only: the choice the create request will carry. */
		onPendingChange?: (value: WorkerAttributeValue) => void;
		/** `saved` only: writes the choice through the Worker Attribute patch. */
		onUpdate?: (value: WorkerAttributeValue) => Promise<void>;
	};

	let {
		worker,
		attribute,
		mode = 'saved',
		refresh = async () => {},
		onSaved,
		onPendingChange,
		onUpdate
	}: Props = $props();

	const panelDraft = getPanelDraft();
	const choices = $derived(answerChoices(attribute));

	let editing = $state(false);
	let draft = $state<WorkerAttributeValue>('');
	let errorMessage = $state('');
	let saving = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let select = $state<HTMLSelectElement | null>(null);
	let form = $state<HTMLFormElement | null>(null);

	/** What the record holds, in the shape this row's editor uses. */
	function savedValue(): WorkerAttributeValue {
		const held = heldAnswerIds(worker, attribute);
		return Array.isArray(held) ? [...held] : held;
	}

	const reading = $derived(describeAnswerValue(attribute, savedValue()));

	onMount(() => {
		draft = savedValue();
		if (mode !== 'saved') return;
		const restored = panelDraft.restored.attributes[attribute.id];
		if (restored === undefined) return;
		draft = copyAttributeValue(restored);
		editing = true;
	});

	// An open editor's choice belongs to the panel's draft: switching Workers stores
	// it, and selecting this one again reopens it. Closing takes it back out.
	$effect(() => {
		if (mode !== 'saved' || !editing) return;
		panelDraft.setAttribute(attribute.id, draft);
		return () => panelDraft.setAttribute(attribute.id, undefined);
	});

	function focusTrigger() {
		void tick().then(() => trigger?.focus());
	}

	/** The first control an editor focuses: the select, or the first checkbox. */
	function focusEditor() {
		void tick().then(() => {
			const control =
				select ?? form?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
			control?.focus();
		});
	}

	function startEditing() {
		draft = savedValue();
		errorMessage = '';
		editing = true;
		focusEditor();
	}

	function cancel() {
		if (saving) return;
		editing = false;
		errorMessage = '';
		draft = savedValue();
		focusTrigger();
	}

	function toggle(choice: string, checked: boolean) {
		const current = Array.isArray(draft) ? draft : [];
		// Choosing a branch of a Single-Select group replaces that group's other branches.
		draft = checked ? pickAnswer(attribute, current, choice) : current.filter((v) => v !== choice);
	}

	/** What Save sends: known answer ids only, with no duplicates. */
	function nextValue(): WorkerAttributeValue {
		if (!storesList(attribute)) return typeof draft === 'string' ? draft : '';
		const values = Array.isArray(draft) ? draft : [];
		return [...new Set(values)].filter((id) =>
			attribute.answers.some((answer) => answer.id === id)
		);
	}

	/**
	 * Saves what the editor holds. Answers `true` once it is closed again or there
	 * was nothing to write, and `false` when the write was refused: the editor stays
	 * open with the UI's own message and focus goes back to its control.
	 *
	 * `refocus` is false when the view flushes the draft to move off the Worker; the
	 * value button is about to be replaced by the next record's.
	 */
	async function commit(refocus = true): Promise<boolean> {
		if (saving) return true;

		const next = nextValue();
		if (mode === 'pending') {
			onPendingChange?.(next);
			editing = false;
			if (refocus) focusTrigger();
			return true;
		}

		const previous = savedValue();
		// Nothing changed: no request, no status message, just the value back.
		if (sameAttributeValue(next, previous)) {
			editing = false;
			if (refocus) focusTrigger();
			return true;
		}

		if (!onUpdate) return false;

		saving = true;
		errorMessage = '';
		// Snapshot the write: Undo must reach this Worker even after the selection moved.
		const update = onUpdate;
		const workerName = worker.name;
		const field = attribute.name;
		const report = await runSingleEdit({
			apply: () => update(next),
			restore: () => update(previous),
			refresh,
			summary: m.workers_field_saved({ worker: workerName, field }),
			fallback: m.workers_field_save_fallback({ field })
		});
		saving = false;

		if (report.error) {
			// The UI's words for a refused write, by the core's code (ADR-0024).
			errorMessage =
				report.errorCode === 'worker_not_found'
					? m.workers_save_worker_deleted()
					: m.workers_save_field_failed({ field });
			focusEditor();
			return false;
		}

		editing = false;
		if (refocus) focusTrigger();
		onSaved?.(report);
		return true;
	}
</script>

<div class="grid min-w-0 gap-1">
	<dt class="key">{attribute.name}</dt>
	<dd class="min-w-0 text-sm">
		{#if editing}
			<!-- Escape is caught on the way up from the form's own controls. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<form
				bind:this={form}
				class="grid gap-2"
				novalidate
				onkeydown={(event) => {
					if (event.key !== 'Escape') return;
					event.preventDefault();
					event.stopPropagation();
					cancel();
				}}
				onsubmit={(event) => {
					event.preventDefault();
					void commit();
				}}
			>
				<fieldset class="grid min-w-0 gap-1.5">
					<legend class="sr-only">{attribute.name}</legend>
					{#if !storesList(attribute)}
						<select
							bind:this={select}
							class="min-h-tap w-full min-w-0 rounded-item border border-rule bg-panel px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring lg:h-8"
							aria-label={attribute.name}
							value={typeof draft === 'string' ? draft : ''}
							onchange={(event) => (draft = event.currentTarget.value)}
						>
							<option value="">{m.common_none()}</option>
							{#each choices as choice (choice.value)}
								<option value={choice.value}>{choice.label}</option>
							{/each}
						</select>
					{:else}
						<div
							class="grid max-h-48 gap-0.5 overflow-y-auto rounded-control border border-rule p-1.5"
						>
							{#each choices as choice (choice.value)}
								<label class="flex min-h-tap items-center gap-2 rounded-item px-1 text-sm">
									<input
										type="checkbox"
										class="size-4 shrink-0 accent-action"
										checked={Array.isArray(draft) && draft.includes(choice.value)}
										onchange={(event) => toggle(choice.value, event.currentTarget.checked)}
									/>
									<span class="min-w-0 break-words">{choice.label}</span>
								</label>
							{/each}
						</div>
					{/if}
				</fieldset>
				{#if errorMessage}
					<p role="alert" class="text-sm text-state-error">{errorMessage}</p>
				{/if}
				<div class="flex items-center gap-2">
					<Button type="submit" size="sm" class="min-h-tap lg:min-h-8" disabled={saving}
						>{m.common_save()}</Button
					>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						class="min-h-tap lg:min-h-8"
						onclick={cancel}
						disabled={saving}
					>
						{m.common_cancel()}
					</Button>
				</div>
			</form>
		{:else}
			<!-- Kept raw: the reading is shown as text and edited in place; the ui Button would restyle it. -->
			<button
				type="button"
				bind:this={trigger}
				class={cn(
					'flex w-full min-w-0 items-center rounded-item px-2 py-1 text-left transition-colors duration-150 outline-none',
					'hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none'
				)}
				aria-label={m.workers_edit_attribute({ field: attribute.name })}
				onclick={startEditing}
			>
				<span class="prose-value min-w-0 text-sm break-words">{reading}</span>
			</button>
		{/if}
	</dd>
</div>
