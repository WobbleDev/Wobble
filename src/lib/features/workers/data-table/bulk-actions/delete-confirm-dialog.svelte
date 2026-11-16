<script lang="ts">
	/**
	 * The one destructive confirm for deleting Workers, shared by the row menu
	 * and the bulk bar: solid destructive fill, "Delete {subject}" / "Cancel".
	 */
	import type { Snippet } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { m } from '#lib/paraglide/messages.js';

	type Props = {
		open: boolean;
		/** What is being deleted, as the title and the button name it: "Ada" or "2 workers". */
		subject: string;
		pending: boolean;
		onConfirm: () => void;
		/** Shown in the dialog when the caller keeps failures here rather than elsewhere. */
		errorMessage?: string | null;
		children: Snippet;
	};

	let { open = $bindable(), subject, pending, onConfirm, errorMessage, children }: Props = $props();
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.workers_delete_title({ subject })}</AlertDialog.Title>
			<AlertDialog.Description>{@render children()}</AlertDialog.Description>
		</AlertDialog.Header>
		{#if errorMessage}
			<p class="text-sm text-destructive" role="alert">{errorMessage}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={pending}>{m.common_cancel()}</AlertDialog.Cancel>
			<Button
				variant="destructive"
				class="bg-destructive text-on-action hover:bg-destructive/90"
				disabled={pending}
				onclick={onConfirm}
			>
				{pending ? m.workers_delete_pending() : m.workers_delete_action({ subject })}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
