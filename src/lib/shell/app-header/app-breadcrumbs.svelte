<script lang="ts">
	/**
	 * The breadcrumb trail for the route you are on.
	 */
	import { page } from '$app/state';
	import * as Breadcrumb from '#lib/components/ui/breadcrumb/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { routeTitle } from '#lib/i18n/route-copy.ts';
	import { overviewFocus } from '#lib/features/overview/overview-focus.svelte.ts';

	/* On the focused Overview the trail reads Worksite > Overview > My Committee, and the
	   Overview crumb is the way back, as the column's own button is. */
	const focus = overviewFocus();
	const onCommittee = $derived(page.url.pathname === '/overview' && focus.focused);
	/* Settings is installation-wide, so it names no Worksite. */
	const onSettings = $derived(page.url.pathname === '/settings');

	const currentTitle = $derived(routeTitle(page.data.titleKey));
	const worksiteName = $derived(page.data.worksite?.name ?? null);
</script>

<Breadcrumb.Root class="label">
	<!-- The list inherits the trail's label voice; its own default re-declares
	     body size in ink-muted, which is what made the trail render at 14px
	     instead of the 11px the root declares (the recorded divergence). -->
	<Breadcrumb.List class="min-w-0 flex-nowrap items-center text-xs text-ink">
		{#if onSettings}
			<Breadcrumb.Item class="shrink-0">
				<Breadcrumb.Page>{currentTitle}</Breadcrumb.Page>
			</Breadcrumb.Item>
		{:else}
			{#if worksiteName}
				<Breadcrumb.Item class="min-w-0 shrink">
					<!-- The link keeps the component's inline-flex centring; the text itself
					     truncates, so the segment stays on the crumbs' line at every width. -->
					<Breadcrumb.Link
						href="/overview"
						class="max-w-full min-w-0 lg:max-w-[48ch]"
						title={worksiteName}
					>
						<span class="block min-w-0 truncate">{worksiteName}</span>
					</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="shrink-0" />
			{/if}
			{#if onCommittee}
				<Breadcrumb.Item class="shrink-0">
					<button
						type="button"
						data-breadcrumb-back
						class="inline-flex min-h-tap items-center rounded-item uppercase transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:min-h-0"
						onclick={() => focus.blur()}
					>
						{currentTitle}
					</button>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="shrink-0" />
				<Breadcrumb.Item class="shrink-0">
					<Breadcrumb.Page>{m.overview_committee_title()}</Breadcrumb.Page>
				</Breadcrumb.Item>
			{:else}
				<Breadcrumb.Item class="shrink-0">
					<Breadcrumb.Page>{currentTitle}</Breadcrumb.Page>
				</Breadcrumb.Item>
			{/if}
		{/if}
	</Breadcrumb.List>
</Breadcrumb.Root>
