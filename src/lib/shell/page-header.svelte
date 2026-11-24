<script lang="ts">
	/**
	 * The per-page title block that sits under the app header.
	 *
	 * A route may hand it one accessory to stand beside the title, and a trailing control right-aligned in the title row — the Overview
	 * puts its chart help there — and the header itself knows nothing about what
	 * that accessory is: it only says where it goes. On the Overview, focusing the
	 * bullseye makes this block read My Committee.
	 */
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import { overviewFocus } from '#lib/features/overview/overview-focus.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { routeSubtitle, routeTitle } from '#lib/i18n/route-copy.ts';

	let { titleAccessory, titleTrailing }: { titleAccessory?: Snippet; titleTrailing?: Snippet } =
		$props();

	const focus = overviewFocus();
	/* The focus state outlives the route, so the route is checked with it. */
	const onCommittee = $derived(page.url.pathname === '/overview' && focus.focused);
	const title = $derived(
		onCommittee ? m.overview_committee_title() : routeTitle(page.data.titleKey)
	);
	const subtitle = $derived(routeSubtitle(page.data.titleKey));
</script>

<header class="grid gap-1">
	<div class="flex items-center gap-2">
		{#key title}
			<h1 class="page-title text-2xl font-semibold tracking-display">{title}</h1>
		{/key}
		{@render titleAccessory?.()}
		{@render titleTrailing?.()}
	</div>
	{#if subtitle}
		<!-- Kept in the flow while the column speaks, so the page below does not move. -->
		<p
			class="max-w-prose text-sm text-ink-3"
			class:invisible={onCommittee}
			aria-hidden={onCommittee ? 'true' : undefined}
		>
			{subtitle}
		</p>
	{/if}
</header>

<style>
	/* The title changes on the column's own beat: after the card has left, as the head lands. */
	.page-title {
		animation: title-in 320ms ease-out 200ms backwards;
	}
	@keyframes title-in {
		from {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(html:not([data-motion='full'])) .page-title {
			animation: none;
		}
	}
	:global(html[data-motion='reduce']) .page-title {
		animation: none;
	}
</style>
