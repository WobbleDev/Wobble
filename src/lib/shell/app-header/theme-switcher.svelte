<script lang="ts">
	/**
	 * The Theme control. It writes the installation-wide setting, so it needs a
	 * Configuration-free page.
	 */
	import { getContext } from 'svelte';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { appSettingsContextKey, type AppSettingsContext } from '#lib/shared/app-settings.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/ui/button/index.ts';
	import IconTip from '#lib/shared/icon-tip.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);
	const themeLabel = $derived(
		settings.isDark ? m.shell_switch_to_light() : m.shell_switch_to_dark()
	);
</script>

<IconTip label={themeLabel}>
	{#snippet child({ props })}
		<Button
			{...props}
			variant="ghost"
			size="icon"
			class="size-tap lg:size-9"
			aria-label={themeLabel}
			aria-pressed={settings.isDark}
			onclick={() => void settings.update({ theme: settings.isDark ? 'light' : 'dark' })}
		>
			{#if settings.isDark}
				<SunIcon />
			{:else}
				<MoonIcon />
			{/if}
		</Button>
	{/snippet}
</IconTip>
