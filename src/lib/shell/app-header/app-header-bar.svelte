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
	import IconTip from '#lib/shared/icon-tip.svelte';
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
		class="pointer-events-auto col-span-3 flex min-w-0 items-center gap-2 lg:order-2 lg:col-auto lg:ml-auto"
	>
		{#if worksite && isDataView}
			<Button
				variant="outline"
				size="sm"
				class="min-h-tap min-w-0 flex-1 px-2 whitespace-nowrap lg:min-h-9 lg:flex-none lg:px-3"
				onclick={() => (importOpen = true)}
			>
				<UploadIcon data-icon="inline-start" />
				{m.shell_import_contacts()}
			</Button>
		{/if}
	</div>
	<div
		data-tauri-drag-region
		class="pointer-events-auto col-start-3 row-start-1 lg:order-3 lg:col-auto lg:row-auto"
	>
		<ThemeSwitcher />
	</div>
</header>

{#if importOpen}
	<ContactCsvImportDialog bind:open={importOpen} />
{/if}
