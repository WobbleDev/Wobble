<script lang="ts">
	/**
	 * One ordinary Attribute in the record panel: its label, the current reading, and
	 * an editor that opens as a popover from the reading, so the rows around it never
	 * move. Single-Select holds one answer or none; Multi-Select holds several
	 * distinct answers or none. Answers save one
	 * Attribute through `PATCH /api/workers/:id` and report through the status line,
	 * with Undo. An open editor's choices are part of the Worker draft (ADR-0023), so
	 * moving off the record keeps them and coming back reopens them.
	 *
	 * New Worker uses the same row in `pending` mode: Save updates the choices the
	 * create request will send, rather than writing a record that does not exist yet.
	 */
	import { onMount, tick } from 'svelte';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import { cn } from '#lib/utils.ts';
	import { pickAnswer, storesList } from '#lib/shared/workers/select-mode.ts';
	import type {
		Worker,
		WorkerAttributeDefinition,
		WorkerAttributeValue
	} from '#lib/domain-vocabulary.ts';
	import { answerChoices, describeAnswerValue, heldAnswerIds } from '../answers.ts';
	import { runSingleEdit } from '../data-table/bulk-actions/bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/features.ts';
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
	let form = $state<HTMLFormElement | null>(null);
	/** Restored drafts reopen the popover without taking focus from where the organizer is. */
	let restoredOpen = $state(false);

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
		restoredOpen = true;
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

	/** The first control an editor focuses: the chosen radio, else the first radio or checkbox. */
	function focusEditor() {
		void tick().then(() => {
			const control =
				form?.querySelector<HTMLInputElement>('input:checked') ??
				form?.querySelector<HTMLInputElement>('input') ??
				null;
			control?.focus();
		});
	}

	function startEditing() {
		draft = savedValue();
		errorMessage = '';
		restoredOpen = false;
		editing = true;
	}

	/** The popover's own open and close (Escape, a click elsewhere) reach the same paths as the buttons. */
	function setOpen(open: boolean) {
		if (open) startEditing();
		else if (editing) cancel();
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

<div class="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-start gap-x-2 gap-y-1">
	<dt class="py-1 text-sm wrap-anywhere text-ink-3">{attribute.name}</dt>
	<dd class="min-w-0 text-sm">
		<Popover.Root open={editing} onOpenChange={setOpen}>
			<!-- Kept raw: the reading is shown as text and edited from it; the ui Button would restyle it. -->
			<Popover.Trigger
				bind:ref={trigger}
				class={cn(
					'flex w-full min-w-0 items-center rounded-item px-2 py-1 text-left transition-colors duration-150 outline-none',
					'hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none',
					editing && 'bg-hover'
				)}
				aria-label={m.workers_edit_attribute({ field: attribute.name })}
			>
				<span class="prose-value min-w-0 text-sm break-words">{reading}</span>
			</Popover.Trigger>
			<Popover.Content
				align="start"
				collisionPadding={8}
				class="w-64 gap-2 p-2"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					if (!restoredOpen) focusEditor();
				}}
				onCloseAutoFocus={(event) => event.preventDefault()}
			>
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
							<div
								role="radiogroup"
								aria-label={attribute.name}
								class="grid max-h-56 gap-0.5 overflow-y-auto"
							>
								{#each [{ value: '', label: m.common_none() }, ...choices] as choice (choice.value)}
									<!-- A native radio laid transparently over its row: arrow keys and checked state come with it. -->
									<label
										class="relative flex min-h-tap cursor-pointer items-center gap-2 rounded-item px-2 text-sm hover:bg-hover has-[:checked]:bg-inset has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring lg:min-h-8"
									>
										<input
											type="radio"
											class="absolute inset-0 m-0 cursor-pointer opacity-0"
											name={`${attribute.id}-answer`}
											value={choice.value}
											checked={(typeof draft === 'string' ? draft : '') === choice.value}
											onchange={() => (draft = choice.value)}
										/>
										<span class="min-w-0 flex-1 break-words">{choice.label}</span>
										{#if (typeof draft === 'string' ? draft : '') === choice.value}
											<CheckIcon class="size-4 shrink-0" aria-hidden="true" />
										{/if}
									</label>
								{/each}
							</div>
						{:else}
							<div class="grid max-h-56 gap-0.5 overflow-y-auto">
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
					<div class="flex items-center gap-2 border-t border-rule pt-2">
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
			</Popover.Content>
		</Popover.Root>
	</dd>
</div>
