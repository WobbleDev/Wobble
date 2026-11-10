<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import { isTauriTransport } from '#lib/client/transport.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import DataErrorNotice from './data-error-notice.svelte';
	import { createFileReceipt } from './file-receipt.svelte.ts';
	let { path }: { path: string } = $props();
	const receipt = createFileReceipt(() => path);
</script>

<code
	data-selectable
	class="prose-value min-w-0 rounded-control bg-inset px-3 py-2 font-mono text-xs leading-5 break-all text-ink-2 select-text"
	>{path}</code
>
<div class="flex flex-wrap gap-2">
	<Button
		type="button"
		variant="outline"
		class="min-h-tap md:min-h-9"
		onclick={() => void receipt.copy.copy(path)}
	>
		{#if receipt.copy.copied}<Check aria-hidden="true" class="size-4" />{m.settings_copied()}
		{:else}<Copy aria-hidden="true" class="size-4" />{m.settings_copy_path()}{/if}
	</Button>
	{#if isTauriTransport()}
		<Button
			type="button"
			variant="outline"
			class="min-h-tap md:min-h-9"
			disabled={receipt.revealing}
			onclick={() => void receipt.reveal()}
		>
			<FolderOpen aria-hidden="true" class="size-4" />{m.settings_show_in_finder()}
		</Button>
	{/if}
</div>
{#if receipt.copy.error}<p role="alert" class="text-sm text-state-error">
		{receipt.copy.error}
	</p>{/if}
{#if receipt.error}<DataErrorNotice error={receipt.error} />{/if}
