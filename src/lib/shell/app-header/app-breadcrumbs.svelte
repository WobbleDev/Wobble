<script lang="ts">
	/**
	 * The breadcrumb trail for the route you are on.
	 */
	import { page } from '$app/state';
	import * as Breadcrumb from '#lib/components/ui/breadcrumb/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { routeTitle } from '#lib/i18n/route-copy.ts';

	const currentTitle = $derived(routeTitle(page.data.titleKey));
	const worksiteName = $derived(
		page.data.worksite ? page.data.worksite.name : m.page_worksite_fallback()
	);
</script>

<Breadcrumb.Root class="label">
	<!-- The list inherits the trail's label voice; its own default re-declares
	     body size in ink-muted, which is what made the trail render at 14px
	     instead of the 11px the root declares (the recorded divergence). -->
	<Breadcrumb.List class="text-xs text-ink">
		<Breadcrumb.Item>
			<Breadcrumb.Link href="/overview" class="block max-w-[48ch] truncate" title={worksiteName}
				>{worksiteName}</Breadcrumb.Link
			>
		</Breadcrumb.Item>
		<Breadcrumb.Separator />
		<Breadcrumb.Item>
			<Breadcrumb.Page>{currentTitle}</Breadcrumb.Page>
		</Breadcrumb.Item>
	</Breadcrumb.List>
</Breadcrumb.Root>
