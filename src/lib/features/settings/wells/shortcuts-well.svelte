<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { shortcutGroups } from '../shortcut-metadata.ts';
	import SettingsWell from '../settings-well.svelte';

	const groups = $derived(shortcutGroups());
</script>

<SettingsWell
	id="shortcuts"
	title={m.settings_shortcuts_title()}
	description={m.settings_shortcuts_description()}
>
	{#each groups as group (group.name)}
		<div class="border-t border-rule px-6 py-4">
			<h3 class="key mb-2">{group.name}</h3>
			<dl class="grid gap-x-8 gap-y-1">
				{#each group.items as item (item.action)}
					<div class="flex items-center justify-between gap-6 py-1.5">
						<dt class="min-w-0 text-sm text-ink-2">{item.action}</dt>
						<dd class="flex shrink-0 gap-1">
							{#each item.keys as key (key)}
								<kbd
									class="grid min-h-6 min-w-6 place-items-center rounded-control border border-rule-strong bg-inset px-1.5 font-mono text-xs text-ink-2"
									>{key}</kbd
								>
							{/each}
						</dd>
					</div>
				{/each}
			</dl>
		</div>
	{/each}
</SettingsWell>
