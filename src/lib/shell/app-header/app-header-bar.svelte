<script lang="ts">
	/**
	 * The top bar: the breadcrumbs, and the contact import.
	 *
	 * The Worksite mutation actions live on the data views only — Overview,
	 * Workers, Mapping — while theme and navigation stay shared everywhere.
	 */
	import { page } from '$app/state';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Sidebar from '#lib/components/ui/sidebar/index.ts';
	import type { Worksite } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import IconTip from '#lib/shared/ui/icon-tip.svelte';
	import AppBreadcrumbs from './app-breadcrumbs.svelte';
	import ContactCsvImportDialog from '../../features/workers/contact-import/contact-csv-import-dialog.svelte';
	import ThemeSwitcher from './theme-switcher.svelte';
	import { cn } from '#lib/utils.ts';

	let {
		worksite,
		class: className
	}: {
		worksite: Worksite | null;
		class?: string;
	} = $props();
	const rail = Sidebar.useSidebar();
	/** Import contacts mutates the Worksite, so it stands on the
	    data views and nowhere else. */
	const isDataView = $derived(['/overview', '/workers', '/mapping'].includes(page.url.pathname));
	let importOpen = $state(false);
</script>

<header
	data-tauri-drag-region
	class={cn(
		'grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 px-3 py-2 lg:flex lg:h-14 lg:justify-start lg:px-6 lg:py-0',
		className
	)}
>
	<div
		data-tauri-drag-region
		class="pointer-events-auto col-span-2 row-start-1 flex min-w-0 items-center gap-2 lg:order-1 lg:col-auto"
	>
		<IconTip label={m.shell_open_navigation()}>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon"
					class="size-tap shrink-0 p-0 lg:hidden"
					aria-label={m.shell_open_navigation()}
					aria-expanded={rail.openMobile}
					onclick={() => rail.toggle()}
				>
					<MenuIcon />
				</Button>
			{/snippet}
		</IconTip>
		<div data-tauri-drag-region class="min-w-0 flex-1">
			<AppBreadcrumbs />
		</div>
	</div>
	<div
		data-tauri-drag-region
		class="pointer-events-auto col-start-3 row-start-1 flex items-center gap-1 lg:order-3 lg:col-auto lg:row-auto lg:ml-auto lg:gap-2"
	>
		{#if worksite && isDataView}
			<IconTip label={m.shell_import_contacts()}>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="outline"
						size="sm"
						class="min-h-tap min-w-tap shrink-0 p-0 whitespace-nowrap lg:h-8 lg:min-h-9 lg:w-auto lg:min-w-0 lg:px-3"
						aria-label={m.shell_import_contacts()}
						onclick={() => (importOpen = true)}
					>
						<UploadIcon data-icon="inline-start" />
						<span class="hidden lg:inline">{m.shell_import_contacts()}</span>
					</Button>
				{/snippet}
			</IconTip>
		{/if}
		<ThemeSwitcher />
	</div>
</header>

{#if importOpen}
	<ContactCsvImportDialog bind:open={importOpen} />
{/if}
