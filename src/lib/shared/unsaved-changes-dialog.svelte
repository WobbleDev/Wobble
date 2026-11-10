<!--
	The one prompt for abandoning a dirty Configuration draft. It is rendered by
	the layout and driven by the shared guard, so a nav link, the browser's Back
	button, a Worksite switch and a new Worksite all ask here — and a Discard that
	then navigates cannot raise a second prompt, because the guard stands down
	while its own release is in flight.
-->
<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { UnsavedChanges } from '#lib/shared/unsaved-changes.svelte.ts';

	let { guard }: { guard: UnsavedChanges } = $props();
</script>

<AlertDialog.Root
	open={guard.open}
	onOpenChange={(open) => {
		// Escape and a click outside are Stay: they must not throw the draft away.
		if (!open) guard.stay();
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{guard.title}</AlertDialog.Title>
			<AlertDialog.Description>{guard.description}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => guard.stay()}
				>{m.unsaved_keep_editing()}</AlertDialog.Cancel
			>
			<AlertDialog.Action onclick={() => void guard.discard()}>
				{guard.confirmLabel}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
