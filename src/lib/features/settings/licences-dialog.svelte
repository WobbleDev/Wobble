<script lang="ts">
	import { Input } from '#lib/components/ui/input/index.ts';
	import * as Dialog from '#lib/components/ui/dialog/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { filterPackages, loadLicences, type LicenceData } from './licences.ts';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	let data = $state<LicenceData | null>(null);
	let failed = $state(false);
	let query = $state('');

	/* Read once, the first time the list opens. */
	$effect(() => {
		if (!open || data || failed) return;
		loadLicences().then(
			(loaded) => (data = loaded),
			() => (failed = true)
		);
	});

	const shown = $derived(data ? filterPackages(data.packages, query) : []);
</script>

<Dialog.Root
	bind:open
	onOpenChange={(next) => {
		if (!next) query = '';
	}}
>
	<Dialog.Content class="max-h-[85vh] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{m.settings_licences()}</Dialog.Title>
			<Dialog.Description>
				{data ? m.settings_licences_count({ count: data.count }) : m.settings_licences_intro()}
			</Dialog.Description>
		</Dialog.Header>
		<Input
			type="search"
			bind:value={query}
			disabled={!data}
			aria-label={m.settings_licences_search()}
			placeholder={m.settings_licences_search()}
		/>
		<div class="min-h-0 overflow-y-auto" data-licence-list>
			{#if failed}
				<p role="alert" class="text-sm text-state-error">{m.settings_licences_error()}</p>
			{:else if !data}
				<p class="text-sm text-ink-3" aria-live="polite">{m.settings_reading()}</p>
			{:else if shown.length === 0}
				<p class="text-sm text-ink-3">{m.settings_licences_none()}</p>
			{:else}
				<ul class="grid">
					{#each shown as pkg (`${pkg.ecosystem}:${pkg.name}@${pkg.version}`)}
						<li class="border-t border-rule first:border-t-0">
							<details data-licence={pkg.name}>
								<summary class="flex cursor-pointer flex-wrap items-baseline gap-x-3 py-2">
									<span class="text-sm font-medium text-ink">{pkg.name}</span>
									<span class="num text-sm text-ink-3">{pkg.version}</span>
									<span class="text-sm text-ink-2">{pkg.license}</span>
								</summary>
								<div class="grid gap-3 pb-3">
									{#each pkg.texts as id (id)}
										<pre
											class="max-h-72 overflow-auto rounded-control bg-inset p-3 text-xs leading-relaxed whitespace-pre-wrap text-ink-2"
											data-selectable>{data.texts[id]}</pre>
									{:else}
										<p class="text-sm text-ink-3">{m.settings_licences_no_text()}</p>
									{/each}
								</div>
							</details>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
