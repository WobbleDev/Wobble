<script lang="ts">
	import type { DataErrorCopy } from '#lib/client/data-api.ts';
	import { m } from '#lib/paraglide/messages.js';

	let { error }: { error: DataErrorCopy } = $props();
</script>

<div class="grid gap-1">
	<p role="alert" class="text-sm text-state-error">{error.message}</p>
	{#if error.detail}
		<details class="text-sm text-ink-3">
			<summary class="w-fit cursor-pointer">{m.settings_show_details()}</summary>
			<p class="mt-1 font-mono text-xs break-words">{error.detail}</p>
		</details>
	{/if}
</div>
