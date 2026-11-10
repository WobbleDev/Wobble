<script lang="ts">
	/**
	 * The checkbox every worker row leads with, and the select-all checkbox in
	 * its header. Selection state lives in `data-table-selection.svelte.ts`,
	 * not in the table's own state, so it survives filtering, sorting and
	 * virtualization.
	 *
	 * The header checkbox means "every worker these filters match" — it reads
	 * its checked and indeterminate states from the filtered row model, so the
	 * rows a virtualizer has not mounted are selected too, and a hidden
	 * hand-picked selection is neither claimed nor dropped.
	 */
	import type { Worker } from '#lib/domain-vocabulary.ts';
	import type { WorkersSelection } from './data-table-selection.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';

	let { worker, selection }: { worker?: Worker; selection?: WorkersSelection } = $props();
	/** Whether Shift was held on the click that is about to fire `change`. */
	let shift = false;
</script>

{#if worker}
	<label class="flex size-tap items-center justify-center lg:size-auto">
		<!-- Kept raw: a native checkbox with the accent colour; the vendored Checkbox draws a different control, which would change the pixels. -->
		<input
			type="checkbox"
			class="size-4 accent-action"
			checked={selection?.isSelected(worker.id) ?? false}
			aria-label={m.workers_select_worker({ name: worker.name })}
			onclick={(event) => (shift = event.shiftKey)}
			onchange={async (event) => {
				const box = event.currentTarget;
				const range = shift;
				const prior = !box.checked;
				shift = false;
				// A refused gate leaves the row unchecked.
				if (!(await selection?.toggle(worker.id, box.checked, range))) box.checked = prior;
			}}
		/>
	</label>
{:else}
	<label class="flex size-tap items-center justify-center lg:size-auto">
		<!-- Kept raw: the header checkbox sets indeterminate on the native element and reverts a refused change, as the row checkbox does. -->
		<input
			type="checkbox"
			class="size-4 accent-action disabled:opacity-40"
			checked={selection?.allMatchingSelected ?? false}
			indeterminate={selection?.someMatchingSelected ?? false}
			disabled={(selection?.matchingCount ?? 0) === 0}
			aria-label={m.workers_select_all()}
			onchange={async (event) => {
				const box = event.currentTarget;
				if (!(await selection?.setAllMatching(box.checked))) box.checked = false;
			}}
		/>
	</label>
{/if}
