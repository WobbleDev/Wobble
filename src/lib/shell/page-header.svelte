<script lang="ts">
	/**
	 * The per-page title block that sits under the app header.
	 *
	 * A route may hand it one accessory to stand beside the title, and a trailing control right-aligned in the title row — the Overview
	 * puts its chart help there — and the header itself knows nothing about what
	 * that accessory is: it only says where it goes.
	 */
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { routeSubtitle, routeTitle } from '#lib/i18n/route-copy.ts';

	let { titleAccessory, titleTrailing }: { titleAccessory?: Snippet; titleTrailing?: Snippet } =
		$props();

	const title = $derived(routeTitle(page.data.titleKey));
	const subtitle = $derived(routeSubtitle(page.data.titleKey));
</script>

<header class="grid gap-1">
	<div class="flex items-center gap-2">
		<h1 class="text-2xl font-semibold tracking-display">{title}</h1>
		{@render titleAccessory?.()}
		{@render titleTrailing?.()}
	</div>
	{#if subtitle}
		<p class="max-w-prose text-sm text-ink-3">{subtitle}</p>
	{/if}
</header>
