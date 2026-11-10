<script lang="ts">
	/**
	 * The Worksite switcher and the view navigation. It warns before switching away from
	 * unsaved Configuration changes.
	 */
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { withQuery } from '#lib/shared/navigation.ts';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import UserGroup from '@lucide/svelte/icons/user-group';
	import Network from '@lucide/svelte/icons/network';
	import Columns3cog from '@lucide/svelte/icons/columns-3-cog';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import * as Sidebar from '#lib/components/ui/sidebar/index.ts';
	import { getUnsavedChanges } from '#lib/shared/unsaved-changes.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { appliedLocale } from '#lib/i18n/locale.ts';
	import type { Worksite } from '#lib/domain-vocabulary.ts';
	import {
		createWorksite as createWorksiteRequest,
		getWorksiteCounts,
		setActiveWorksite
	} from '#lib/client/worksite-api.ts';

	let { worksite, worksites }: { worksite: Worksite | null; worksites: readonly Worksite[] } =
		$props();
	const unsavedChanges = getUnsavedChanges();
	const rail = Sidebar.useSidebar();
	let isPending = $state(false);
	let errorMessage = $state('');
	/** Worker counts by Worksite id, read from one grouped query each time the menu opens. */
	const countsId = $props.id();
	let counts = $state<Record<string, number>>({});

	async function loadCounts(open: boolean) {
		if (!open) return;
		try {
			counts = await getWorksiteCounts();
		} catch {
			counts = {};
		}
	}

	/* Ids, not labels, key the lists: a translated label is display text and must never
	   become an identity. */
	const groups = $derived([
		{
			id: 'views',
			label: m.nav_views(),
			items: [
				{
					id: 'overview',
					title: m.nav_overview(),
					url: '/overview' as const,
					icon: LayoutDashboard
				},
				{ id: 'workers', title: m.nav_workers(), url: '/workers' as const, icon: UserGroup },
				{ id: 'mapping', title: m.nav_mapping(), url: '/mapping' as const, icon: Network }
			]
		}
	]);

	async function switchWorksite(id: string) {
		isPending = true;
		errorMessage = '';

		try {
			await setActiveWorksite(id);
			await goto(resolve('/overview'), { invalidateAll: true });
		} catch {
			errorMessage = m.nav_switch_failed();
		} finally {
			isPending = false;
		}
	}

	function requestWorksiteSwitch(target: Worksite) {
		// The shared guard owns the prompt, so a switch and a nav link cannot each
		// raise their own — and the switch itself is just the held intent.
		void unsavedChanges.request({
			title: m.unsaved_title(),
			description: m.unsaved_switch_worksite({ name: target.name }),
			confirmLabel: m.unsaved_discard_and_switch(),
			run: () => switchWorksite(target.id)
		});
	}

	function requestWorksiteCreation() {
		void unsavedChanges.request({
			title: m.unsaved_title(),
			description: m.unsaved_create_worksite(),
			confirmLabel: m.unsaved_discard_and_create(),
			run: () => createWorksite()
		});
	}

	async function createWorksite() {
		isPending = true;
		errorMessage = '';

		try {
			await createWorksiteRequest(appliedLocale());
			await goto(withQuery(resolve('/overview'), { setup: '1' }), { invalidateAll: true });
		} catch {
			errorMessage = m.nav_create_failed();
		} finally {
			isPending = false;
		}
	}
</script>

<!-- lg:p-[0.875rem] is the rail's outer margin on all four sides. It is padding
     inside the fixed column rather than a CSS margin, so it comes out of the
     card's width and height — --sidebar-width in +layout.svelte is the column,
     and the two are sized together to leave the card 13.25rem. lg: keeps it off
     the mobile drawer, which is meant to sit flush to the window. -->
<Sidebar.Root
	data-tauri-drag-region
	variant="floating"
	class="lg:p-[0.875rem]"
	role="navigation"
	aria-label={m.nav_worksite()}
>
	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.Header class="pt-11">
				<!-- The product name is the one thing in the rail that is not a
				     control; it is set as a wordmark rather than as body copy. -->
				<p class="px-1 text-lg font-semibold tracking-headline text-ink">{m.app_name()}</p>
				<DropdownMenu.Root onOpenChange={loadCounts}>
					<DropdownMenu.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="outline"
								class="min-h-tap w-full justify-between border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground lg:min-h-9"
								aria-label={worksite
									? m.nav_active_worksite({ name: worksite.name })
									: m.nav_select_worksite()}
								title={worksite?.name}
								disabled={isPending}
							>
								<span class="truncate">{worksite?.name ?? m.nav_select_worksite()}</span>
								<ChevronDown />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start">
						<DropdownMenu.Label>{m.nav_worksites()}</DropdownMenu.Label>
						{#each worksites as item (item.id)}
							<DropdownMenu.Item
								onSelect={() => requestWorksiteSwitch(item)}
								disabled={isPending}
								aria-describedby={item.id in counts ? `${countsId}-${item.id}` : undefined}
								class={item.id === worksite?.id ? 'bg-inset font-semibold' : undefined}
							>
								<span class="min-w-0 truncate" title={item.name}>{item.name}</span>
								{#if item.id in counts}
									<span
										id="{countsId}-{item.id}"
										aria-hidden="true"
										class="num ml-auto text-ink-3"
										data-worksite-count>{counts[item.id]}</span
									>
								{/if}
								{#if item.id === worksite?.id}
									<Check class={item.id in counts ? '' : 'ml-auto'} />
								{/if}
							</DropdownMenu.Item>
						{/each}
						<DropdownMenu.Separator />
						<DropdownMenu.Item onSelect={requestWorksiteCreation} disabled={isPending}>
							{m.nav_new_worksite()}
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
				{#if errorMessage}
					<p role="alert" class="text-sm text-destructive">{errorMessage}</p>
				{/if}
			</Sidebar.Header>
		</Sidebar.Group>
		{#each groups as group (group.id)}
			<Sidebar.Group>
				<Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each group.items as item (item.id)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton
									isActive={page.url.pathname === item.url}
									class="min-h-tap lg:min-h-9"
								>
									{#snippet child({ props })}
										<a
											href={resolve(item.url)}
											{...props}
											aria-current={page.url.pathname === item.url ? 'page' : undefined}
											onclick={() => rail.setOpenMobile(false)}
										>
											<item.icon />
											<span>{item.title}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		{/each}
	</Sidebar.Content>
	<Sidebar.Footer>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					isActive={page.url.pathname === '/settings'}
					class="min-h-tap lg:min-h-9"
				>
					{#snippet child({ props })}
						<a
							href={resolve('/settings')}
							{...props}
							aria-current={page.url.pathname === '/settings' ? 'page' : undefined}
							onclick={() => rail.setOpenMobile(false)}
						>
							<SettingsIcon />
							<span>{m.nav_settings()}</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					isActive={page.url.pathname === '/configuration'}
					class="min-h-tap lg:min-h-9"
				>
					{#snippet child({ props })}
						<a
							href={resolve('/configuration')}
							{...props}
							aria-current={page.url.pathname === '/configuration' ? 'page' : undefined}
							onclick={() => rail.setOpenMobile(false)}
						>
							<Columns3cog />
							<span>{m.nav_configuration()}</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Footer>
</Sidebar.Root>
