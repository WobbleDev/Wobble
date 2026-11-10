<script lang="ts">
	/**
	 * The Workers view's one status line, fixed to the bottom right corner of the app shell, so a report never resizes the table. The live
	 * region is always mounted so a screen reader announces each new message
	 * politely, without moving focus. Below `lg` the line sits above the bulk bar:
	 * the table publishes that bar's measured height as `--bulk-bar-height`, so a
	 * message (and its Undo) never covers the bar's actions.
	 */
	import { getEditModel } from './edit-model.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';

	const editModel = getEditModel();

	/** Empty, the line takes no size and draws nothing. */
	const hasContent = $derived(
		Boolean(editModel.status?.message || editModel.error || editModel.status?.undo)
	);

	/** The Undo control's words, so the announcement and the button never disagree. */
	const undoLabel = $derived(
		editModel.undoPending
			? m.workers_status_undoing()
			: editModel.error
				? m.workers_status_try_undo_again()
				: m.common_undo()
	);
</script>

<div
	data-testid="status-line"
	data-empty={!hasContent}
	style="--status-line-bottom: calc(1rem + var(--bulk-bar-height, 0px))"
	class="fixed right-4 z-50 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-x-3 gap-y-1 text-sm data-[empty=false]:min-h-10 data-[empty=false]:rounded-surface data-[empty=false]:bg-panel data-[empty=false]:px-3 data-[empty=false]:py-1.5 data-[empty=false]:shadow-lg data-[empty=false]:ring-1 data-[empty=false]:ring-foreground/10 max-lg:bottom-(--status-line-bottom) lg:bottom-4"
>
	<span role="status" aria-live="polite" class="text-ink-2">
		{editModel.status?.message ?? ''}{#if editModel.status?.undo}<span class="sr-only"
				>, {undoLabel}</span
			>{/if}
	</span>
	{#if editModel.error}
		<span role="alert" class="text-state-error">{editModel.error}</span>
	{/if}
	{#if editModel.status?.undo}
		<!-- Kept raw: a text link with its own hover tint and focus ring; the ui Button adds a fixed height and a border. -->
		<button
			type="button"
			class="inline-flex min-h-tap items-center rounded-item px-1.5 py-0.5 font-medium text-action hover:bg-action/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60 lg:min-h-0"
			disabled={editModel.undoPending}
			aria-busy={editModel.undoPending}
			onclick={() => editModel.undo()}
		>
			{undoLabel}
		</button>
	{/if}
</div>
