<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import SettingsWell from '../settings-well.svelte';

	/* Features that do not exist yet: names only, so nothing here promises or holds state. */
	const items = $derived([
		{ id: 'upd', label: m.settings_updates_title() },
		{ id: 'bak-auto', label: m.settings_auto_backup_title() },
		{ id: 'prv-lock', label: m.settings_lock_title() },
		{ id: 'dx-logs', label: m.settings_log_files_title() },
		{ id: 'about-licences', label: m.settings_licences() }
	]);

	let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<SettingsWell id="unavailable" title={m.settings_not_available()}>
	<details bind:open class="border-t border-rule px-6 py-3">
		<summary class="cursor-pointer text-sm text-ink-3">{items.length}</summary>
		<ul class="mt-2 grid gap-1">
			{#each items as item (item.id)}
				<li data-row={item.id} data-unavailable="true" class="py-1 text-sm text-ink-2">
					{item.label}
				</li>
			{/each}
		</ul>
	</details>
</SettingsWell>
