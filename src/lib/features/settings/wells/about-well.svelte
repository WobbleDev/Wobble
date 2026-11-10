<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { CopyFeedback } from '../copy-feedback.svelte.ts';
	import DataErrorNotice from '../data-error-notice.svelte';
	import {
		aboutRows as buildAboutRows,
		diagnosticText,
		type RuntimeReading
	} from '../runtime-details.ts';
	import SettingsWell from '../settings-well.svelte';

	let { runtime }: { runtime: RuntimeReading } = $props();

	const aboutRows = $derived(buildAboutRows(runtime.value, m.settings_unavailable_value()));
	/* Copy reads the running identity, so it waits for the read and stays off when it failed. */
	const canCopy = $derived(!runtime.loading && runtime.error === null);
	const copy = new CopyFeedback();
</script>

<SettingsWell id="about" title={m.settings_about_title()}>
	{#if runtime.error}
		<div class="px-6 pt-4"><DataErrorNotice error={runtime.error} /></div>
	{/if}
	{#if runtime.loading}
		<p class="border-t border-rule px-6 py-3 text-sm text-ink-3" aria-live="polite">
			{m.settings_reading()}
		</p>
	{:else}
		<dl>
			{#each aboutRows as row (row.key)}
				<div class="flex items-baseline justify-between gap-6 border-t border-rule px-6 py-3">
					<dt class="key">{row.key}</dt>
					<dd class="num text-sm text-ink" data-selectable>{row.value}</dd>
				</div>
			{/each}
		</dl>
	{/if}
	<div class="flex flex-wrap items-center gap-2 border-t border-rule px-6 py-4">
		<Button
			type="button"
			variant="outline"
			class="min-h-tap md:min-h-9"
			disabled={!canCopy}
			onclick={() => void copy.copy(diagnosticText(runtime.value, m.settings_unavailable_value()))}
		>
			{#if copy.copied}
				<Check aria-hidden="true" class="size-4" />
				{m.settings_copied()}
			{:else}
				<Copy aria-hidden="true" class="size-4" />
				{m.settings_copy_details()}
			{/if}
		</Button>
		{#if copy.error}
			<p role="alert" class="text-sm text-state-error">{copy.error}</p>
		{/if}
	</div>
</SettingsWell>
