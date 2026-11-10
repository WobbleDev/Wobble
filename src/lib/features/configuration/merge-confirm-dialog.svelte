<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { createFocusReturn } from './focus-return.svelte.ts';

	type Props = {
		open: boolean;
		/** The text the organizer typed; it folds away. */
		foldingText: string;
		/** The existing value that survives and keeps its place. */
		survivorText: string;
		onConfirm: () => void;
		onCancel: () => void;
	};

	let { open, foldingText, survivorText, onConfirm, onCancel }: Props = $props();

	const returnFocus = createFocusReturn(() => open);
</script>

<AlertDialog.Root
	{open}
	onOpenChange={(next) => {
		if (!next) onCancel();
	}}
>
	<AlertDialog.Content onCloseAutoFocus={returnFocus}>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{m.configuration_merge_title({ survivorText })}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{m.configuration_merge_description({ foldingText, survivorText })}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action onclick={onConfirm}>{m.configuration_merge_action()}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
