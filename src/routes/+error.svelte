<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { dismissSplash } from '#lib/shell/dismiss-splash.ts';
	import { createStartupRecovery } from '#lib/shell/startup-recovery.svelte.ts';
	import { copyText } from '#lib/features/settings/copy-text.ts';
	import { version } from '../../package.json';
	const recovery = createStartupRecovery({
		reload: () => window.location.reload(),
		copy: copyText
	});
	const details = $derived(m.error_start_diagnostic({ version, status: String(page.status) }));
	onMount(dismissSplash);
</script>

<main class="flex min-h-dvh flex-col items-center justify-center gap-4 bg-page p-6 text-center">
	<h1 class="text-2xl font-semibold tracking-headline">{m.error_start_title()}</h1>
	<p role="alert" class="max-w-md text-sm text-ink-2">{m.error_start_body()}</p>
	<Button type="button" class="min-h-tap md:min-h-9" onclick={() => recovery.retry()}
		>{m.error_start_retry()}</Button
	>
	<details class="w-full max-w-md text-left">
		<summary class="min-h-tap cursor-pointer py-3 text-sm text-ink-2"
			>{m.error_start_details()}</summary
		>
		<div class="grid gap-3 py-3">
			<pre
				data-selectable
				class="prose-value font-mono text-xs break-all whitespace-pre-wrap text-ink-2">{details}</pre>
			<Button
				type="button"
				variant="outline"
				class="min-h-tap justify-self-start md:min-h-9"
				onclick={() => void recovery.copy(details)}>{m.error_start_copy()}</Button
			>
			{#if recovery.copyState === 'copied'}<p role="status" class="text-sm text-ink-2">
					{m.error_start_copied()}
				</p>{/if}
			{#if recovery.copyState === 'failed'}<p role="alert" class="text-sm text-state-error">
					{m.error_start_copy_failed()}
				</p>{/if}
		</div>
	</details>
</main>
