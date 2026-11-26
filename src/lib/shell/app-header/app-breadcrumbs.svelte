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
	<Breadcrumb.List class="text-xs text-ink">
		{#if onSettings}
			<Breadcrumb.Item>
				<Breadcrumb.Page>{currentTitle}</Breadcrumb.Page>
			</Breadcrumb.Item>
		{:else}
			{#if worksiteName}
				<Breadcrumb.Item>
					<Breadcrumb.Link href="/overview" class="block max-w-[48ch] truncate" title={worksiteName}
						>{worksiteName}</Breadcrumb.Link
					>
				</Breadcrumb.Item>
				<Breadcrumb.Separator />
			{/if}
			{#if onCommittee}
				<Breadcrumb.Item>
					<button
						type="button"
						data-breadcrumb-back
						class="inline-flex min-h-tap items-center rounded-item uppercase transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:min-h-0"
						onclick={() => focus.blur()}
					>
						{currentTitle}
					</button>
				</Breadcrumb.Item>
				<Breadcrumb.Separator />
				<Breadcrumb.Item>
					<Breadcrumb.Page>{m.overview_committee_title()}</Breadcrumb.Page>
				</Breadcrumb.Item>
			{:else}
				<Breadcrumb.Item>
					<Breadcrumb.Page>{currentTitle}</Breadcrumb.Page>
				</Breadcrumb.Item>
			{/if}
		{/if}
	</Breadcrumb.List>
</Breadcrumb.Root>
