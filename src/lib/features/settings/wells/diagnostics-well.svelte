<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { CopyFeedback } from '../copy-feedback.svelte.ts';
	import DataErrorNotice from '../data-error-notice.svelte';
	import { diagnosticText, type RuntimeReading } from '../runtime-details.ts';
	import SettingsRow from '../settings-row.svelte';
	import SettingsWell from '../settings-well.svelte';

	let { runtime }: { runtime: RuntimeReading } = $props();

	/* Copy reads the running identity, so it waits for the read and stays off when it failed. */
	const canCopy = $derived(!runtime.loading && runtime.error === null);

	const copy = new CopyFeedback();
</script>

<SettingsWell
	id="diagnostics"
	title={m.settings_diagnostics_title()}
	description={m.settings_diagnostics_description()}
>
	<SettingsRow
		id="dx-copy"
		title={m.settings_copy_diagnostics_title()}
		description={m.settings_copy_diagnostics_description()}
	>
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
				{m.settings_copy_info()}
			{/if}
		</Button>
		{#if copy.error}
			<p role="alert" class="text-sm text-state-error">{copy.error}</p>
		{/if}
		{#if runtime.error}
			<DataErrorNotice error={runtime.error} />
		{/if}
	</SettingsRow>
</SettingsWell>
