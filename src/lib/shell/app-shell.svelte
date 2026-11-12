<script lang="ts">
	import { onMount, setContext, untrack } from 'svelte';
	import { appSettingsContextKey } from '#lib/shared/app-settings.ts';
	import {
		destroyWindow,
		exitApp,
		onQuitRequested,
		onWindowCloseRequested
	} from '#lib/client/tauri-window.ts';
	import * as Sidebar from '#lib/components/ui/sidebar/index.ts';
	import { createSettingsSync } from '#lib/shell/settings-sync.svelte.ts';
	import { createShortcutHandler } from '#lib/shell/shortcuts.svelte.ts';
	import NavigationRail from '#lib/shell/navigation-rail.svelte';
	import {
		configurationDraftContextKey,
		type ConfigurationDraftContext
	} from '#lib/features/configuration/configuration-draft-state.svelte.ts';
	import AppHeaderBar from '#lib/shell/app-header/app-header-bar.svelte';
	import UnsavedChangesDialog from '#lib/shared/unsaved-changes-dialog.svelte';
	import { UnsavedChanges, unsavedChangesContextKey } from '#lib/shared/unsaved-changes.svelte.ts';
	import BullseyeBase from '#lib/features/overview/bullseye/bullseye-base.svelte';
	import ChartHelp from '#lib/features/overview/chart-help.svelte';
	import { createBullseyeChartBackdrop } from '#lib/features/overview/bullseye-chart-backdrop.svelte.ts';
	import {
		createOverviewFocus,
		setOverviewFocus
	} from '#lib/features/overview/overview-focus.svelte.ts';
	import OverviewEdgeControl from '#lib/features/overview/overview-edge-control.svelte';
	import { createFirstWorksiteSetup } from '#lib/features/overview/first-worksite.svelte.ts';
	import {
		createOverviewEntranceAnimationController,
		setOverviewEntranceAnimationController
	} from '#lib/features/overview/overview-entrance-animation.svelte.ts';
	import { IsMobile } from '#lib/hooks/is-mobile.svelte.ts';
	import { PanCapability } from '#lib/hooks/pan-capability.svelte.ts';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { cn } from '#lib/utils.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import * as Card from '#lib/components/ui/card/index.ts';
	import type { Attachment } from 'svelte/attachments';
	import { scrollFade } from '#lib/shared/scroll-fade.ts';
	import PageHeader from '#lib/shell/page-header.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { initializeNativeLocale } from '#lib/client/native-shell.ts';
	import { appliedLocale } from '#lib/i18n/locale.ts';
	import { destinationLabel, routeTitle } from '#lib/i18n/route-copy.ts';
	import { setEditModel } from '#lib/features/workers/edit-model.svelte.ts';
	import type { Snippet } from 'svelte';
	import type { WorksiteDataset } from '#lib/client/dataset-api.ts';

	let { children, data }: { children: Snippet; data: WorksiteDataset } = $props();
	/* A desktop app has no browser menu. Fields keep theirs (paste, spell check), and
	   so does selected text in a selectable element, so Copy still works. */
	function suppressContextMenu(event: MouseEvent) {
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest('input, textarea, [contenteditable]')) return;
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed && selection.toString().trim() !== '') {
			const anchor = selection.anchorNode;
			const element = anchor instanceof Element ? anchor : anchor?.parentElement;
			if (element?.closest('[data-selectable], .prose-value, [role="alert"]')) return;
		}
		event.preventDefault();
	}
	const overviewEntranceAnimation = createOverviewEntranceAnimationController(
		untrack(() => data.worksite?.id ?? null)
	);
	setOverviewEntranceAnimationController(overviewEntranceAnimation);
	/* The one gate out of a dirty Configuration draft. It reads the flag from the
	   context below rather than holding a copy, so there is a single answer to
	   "is anything unsaved?" and the guard cannot drift from it. */
	const unsaved = new UnsavedChanges(() => configurationDraft.hasUnsavedChanges);
	const configurationDraft = $state<ConfigurationDraftContext>({ hasUnsavedChanges: false });
	setContext(configurationDraftContextKey, configurationDraft);
	setContext(unsavedChangesContextKey, unsaved);
	// One report bar for the whole install view, so every edit path reports in it.
	const editModel = setEditModel();
	const firstWorksite = createFirstWorksiteSetup();
	/* /workers is the one route whose panel is the Workers table itself, running
	   full-bleed to its own edge. It shares every route's page gutter, so the
	   breadcrumbs, title and content do not shift when switching views. */
	const edgeToEdge = $derived(page.url.pathname === '/workers');
	const noScrollSurface = $derived(
		page.url.pathname === '/overview' || page.url.pathname === '/mapping'
	);
	/* The one route whose bullseye is a chart backdrop behind the shell, rather than a
	   chart in the page beside the panels. */
	const isOverview = $derived(page.url.pathname === '/overview');
	const isMapping = $derived(page.url.pathname === '/mapping');
	const isMobile = new IsMobile();
	const panCapability = new PanCapability();
	/* The draggable chart backdrop is shown only where it can be hovered and moved. Elsewhere
	   — below the split, under reduced motion, or on a coarse pointer — the fitted
	   chart is drawn in the page instead, so every dot stays reachable with no drag. */
	/* The Overview reads the chart backdrop's state from context rather than re-deriving the
	   same conditions, so the chart backdrop and its in-page stand-in can never both render or
	   both vanish, and the chart is always sized by the one scale the shell holds. */
	const chartBackdrop = createBullseyeChartBackdrop(
		() => isOverview,
		() => !isMobile.current && panCapability.allowed
	);
	const chartBackdropShown = $derived(chartBackdrop.shown);
	/* The Overview's focus state: at rest the dashboard reads, focused the bullseye
	   answers. Created beside the bullseye view state and shared the same way, so
	   the edge control, the dashboard and the chart backdrop agree. */
	const focus = createOverviewFocus({ isOverview: () => isOverview });
	setOverviewFocus(focus);
	const isSettingsPage = $derived(page.url.pathname === '/settings');
	const isConfigurationPage = $derived(page.url.pathname === '/configuration');
	/* These two pages scroll under the title, so the viewport fades its top edge. Only they
	   pay for the observers; the Workers table's churning rows never would. */
	const scrollsUnderTitle = $derived(isConfigurationPage || isSettingsPage);
	const fadeTopEdge: Attachment<HTMLElement> = (node) => {
		if (!scrollsUnderTitle) return;
		const fade = scrollFade(node);
		return () => fade.destroy();
	};

	/* The document's own title, derived from what the route and the Worksite say
	   rather than written into the DOM by hand: "View — Worksite — Wobble", or
	   "View — Wobble" while there is no Worksite to name. */
	const documentTitle = $derived(
		[routeTitle(page.data.titleKey), page.data.worksite?.name ?? '', m.app_name()]
			.filter(Boolean)
			.join(' — ')
	);

	/* A dirty draft cancels the navigation and re-issues it once the reader has
	   answered. Cancelling rather than merely warning is what makes Stay a real
	   Stay: the destination is held as the intent's own callback, so nothing has
	   to remember it, and the resumed navigation is the guard's release — which is
	   why it cannot raise a second prompt. */
	beforeNavigate((navigation) => {
		if (unsaved.released) return;
		if (!configurationDraft.hasUnsavedChanges) return;

		const to = navigation.to;
		if (!to) return;
		// A query or hash change is not leaving the draft behind.
		if (to.url.pathname === page.url.pathname) return;

		navigation.cancel();

		const destination = destinationLabel(to.url.pathname);
		void unsaved.request({
			title: m.unsaved_title(),
			description: m.unsaved_leave_configuration({ destination }),
			confirmLabel: m.unsaved_discard_and_leave(),
			// The destination is the URL the cancelled navigation already resolved,
			// so there is no route to hand `resolve` here.
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() takes a route path, not the full URL this resumes.
			run: () => goto(to.url.href)
		});
	});

	/* The platform's own unload warning, registered only while there is something
	   to lose. The copy is the browser's, not ours: a page cannot word it. */
	$effect(() => {
		if (!configurationDraft.hasUnsavedChanges) return;

		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener('beforeunload', warn);
		return () => window.removeEventListener('beforeunload', warn);
	});

	/* WKWebView ignores beforeunload on window close, so under Tauri the close request
	   itself is held and put to the same prompt. Cmd+Q on macOS quits the app without
	   a close request, so it still bypasses this. */
	$effect(() => {
		if (!configurationDraft.hasUnsavedChanges) return;

		return onWindowCloseRequested((keepOpen) => {
			keepOpen();
			void unsaved.request({
				title: m.unsaved_title(),
				description: m.unsaved_close(),
				confirmLabel: m.unsaved_discard_and_close(),
				run: () => destroyWindow()
			});
		});
	});

	/* Cmd+Q, the app menu's Quit and the Dock all arrive as one quit request. Clean, it
	   quits at once; dirty, it asks first. Stay leaves the app running. */
	$effect(() =>
		onQuitRequested(() => {
			void unsaved.request({
				title: m.unsaved_title(),
				description: m.unsaved_quit(),
				confirmLabel: m.unsaved_discard_and_quit(),
				run: () => exitApp()
			});
		})
	);

	const onShortcut = createShortcutHandler({
		hasWorksite: () => !!data.worksite,
		pathname: () => page.url.pathname,
		isConfigurationPage: () => isConfigurationPage,
		requestNewWorker: () => editModel.requestNewWorker()
	});

	$effect(() => {
		const activeWorksiteId = data.worksite?.id ?? null;
		const generationBefore = overviewEntranceAnimation.generation;
		overviewEntranceAnimation.observe(activeWorksiteId);
		if (overviewEntranceAnimation.generation !== generationBefore && activeWorksiteId === null) {
			overviewEntranceAnimation.settle();
		}
	});

	$effect(() => {
		if (!isOverview && overviewEntranceAnimation.state === 'running')
			overviewEntranceAnimation.settle();
		if (
			isOverview &&
			panCapability.reducedMotion &&
			overviewEntranceAnimation.state === 'running'
		) {
			overviewEntranceAnimation.settle();
		}
	});

	/* Focus returns to rest on every Overview entrance animation, as the zoom does; and when
	   the chart backdrop goes away mid-focus, so the dashboard never sits slid and inert
	   where the fitted chart is drawn instead. The generation read subscribes the
	   reset to entrance animations claimed on this route too: switching Worksites claims a
	   new generation without a navigation. */
	$effect(() => {
		void overviewEntranceAnimation.generation;
		focus.resetOnEntranceAnimation();
	});
	$effect(() => {
		if (!chartBackdrop.shown) focus.blur();
	});

	/* Created after the Overview's entrance animation effects, as the settings effects were on
	   main, so effects still run in their original order. */
	const settingsSync = createSettingsSync(untrack(() => data.settings));
	const settingsContext = settingsSync.context;
	setContext(appSettingsContextKey, settingsContext);

	onMount(() => {
		// One native handoff per document initialization. A preference save never runs
		// this; a post-Restore reload does, with the new resolved locale.
		void initializeNativeLocale(appliedLocale(), {
			edit: m.native_menu_edit(),
			window: m.native_menu_window(),
			quit: m.native_menu_quit()
		}).catch((error) => console.error('Could not initialize the native menu language.', error));
		return settingsSync.start();
	});
</script>

<svelte:window oncontextmenu={suppressContextMenu} onkeydown={onShortcut} />
<svelte:head>
	<title>{documentTitle}</title>
</svelte:head>
<!-- --sidebar-width is the reserved column, not the rail card. The card is inset
     within it by the rail's own outer margin, which it carries as padding
     (navigation-rail.svelte), so 15rem here is 13.25rem of card plus 0.875rem all
     round. Changing either number means changing the other. -->
<!-- One tooltip clock for the app: a hover must rest before a tip opens, and a second tip
     opens at once while the reader is still sweeping across controls. -->
<Tooltip.Provider delayDuration={500} skipDelayDuration={300}>
	<Sidebar.Provider class="h-dvh min-h-0 w-full overflow-clip" style="--sidebar-width: 15rem;">
		<a
			href="#main-content"
			class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-panel focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-1 focus:ring-rule-strong focus:outline-none"
		>
			{m.shell_skip_to_content()}
		</a>
		<NavigationRail worksite={data.worksite} worksites={data.worksites} />
		<!-- The vendored Inset paints `bg-background` because the provider fills the
	     gap behind it for the `inset` variant. The rail is `variant="floating"`,
	     whose gutter is the page's own wash, so the Inset overrides that fill and
	     the wash runs unbroken from the gutter into the content. -->
		<Sidebar.Inset
			id="main-content"
			tabindex={-1}
			aria-label={m.shell_main_content()}
			class={cn(
				'relative isolate flex min-h-0 min-w-0 flex-1 flex-col bg-transparent focus:outline-none',
				/* The Overview dashboard and the bullseye floor both run under the
				   navigation rail, in the chart backdrop and the fitted form alike. */
				isOverview || chartBackdropShown
					? '[clip-path:inset(0_0_0_calc(-1*var(--overview-rail-reach)))]'
					: 'overflow-hidden'
			)}
			data-bullseye-base-surface={chartBackdropShown ? '' : undefined}
		>
			<!-- The header paints nothing of its own — no fill, no blur, no edge — so
		     the bullseye chart backdrop reads continuously behind it. It sits above the
		     focused chart backdrop, so the zoomed chart slides under the breadcrumbs and
		     actions instead of covering them. -->
			<AppHeaderBar worksite={data.worksite} class="relative z-[4]" />
			{#if settingsContext.saveError}
				<p role="alert" class="bg-inset px-4 py-2 text-sm text-state-error lg:px-6">
					{settingsContext.saveError}
				</p>
			{:else if settingsContext.syncError}
				<p role="status" class="bg-inset px-4 py-2 text-sm text-ink-2 lg:px-6">
					{m.shell_settings_stale()}
				</p>
			{/if}

			<!-- The lead above the page title is chrome a no-scroll surface buys
		     height back from; layout.css tightens it through --page-header-lead. -->
			<!-- Above the focused chart backdrop with the header, so the title row does too. -->
			<div class="relative z-[4] shrink-0 px-4 pt-(--page-header-lead,1rem) lg:px-6">
				<!-- The chart help stands beside the Overview title rather than in the
			     column's foot, where it spent height the Breakdown needs. Only that
			     route hands PageHeader an accessory. -->
				<PageHeader>
					{#snippet titleAccessory()}
						{#if isOverview}
							<ChartHelp committeeTarget={data.worksite?.committeeTarget ?? 5} />
						{/if}
					{/snippet}
				</PageHeader>
			</div>

			<div
				data-testid="tab-scroll-viewport"
				data-scroll-viewport
				{@attach fadeTopEdge}
				class={cn(
					'z-0 min-h-0 min-w-0 flex-1 overflow-auto',
					/* These pages scroll under the title; a fade gives the viewport a clean top edge. */
					scrollsUnderTitle && 'scroll-fade',
					noScrollSurface && 'no-scroll-enforced surface-no-scroll'
				)}
			>
				<div
					class={cn(
						'flex min-h-full flex-col p-4 lg:p-6',
						edgeToEdge && 'h-full min-h-0',
						noScrollSurface && 'no-scroll-fill',
						isMapping && 'mapping-fill',
						/* The map's canvas is the whole point of the surface: below the
					   Shell tier the page gives up its own gutter so the drawing
					   area uses the available width. */
						(isMapping || isOverview) && 'max-lg:p-2'
					)}
				>
					<Card.Root
						class={cn(
							'h-full min-h-0 min-w-0 flex-1',
							edgeToEdge && '[--card-spacing:0px]',
							/* The card's own inset doubles the page gutter; on the map it
						   goes below the Shell tier for the same reason. */
							(isMapping || isOverview) && 'max-lg:[--card-spacing:0px]',
							/* The Overview bullseye is a chart backdrop behind the pad, so the pad
						   gives up its surface; the panels carry their own. Mapping and the
						   Workers table do the same: each panel is its own surface on the page, so a
						   gap of page ground and its shadow separate it from the glass rail
						   beside it. */
							(isOverview || isMapping || edgeToEdge || isConfigurationPage || isSettingsPage) &&
								'bg-transparent',
							/* The dashboard carries its own panels over the bullseye floor, so the
							   card paints no surface of its own: no fill, no edge, no shadow. */
							isOverview && 'border-transparent shadow-none',
							/* Configuration's save bar is the one thing in the app that sticks to
						   the foot of the pad. The card's overflow-hidden is what normally clips
						   its corners, but it is also a nearer scrollport than the page scroller,
						   which leaves `sticky bottom-0` with nothing to stick to — so on this
						   route the clip is given up in exchange for the bar actually holding.
						   Mapping and Workers give it up too, so a panel's own shadow is not
						   clipped at the pad's edge. The dashboard runs to the rail, so its
						   clip is given up as well. */
							(isConfigurationPage || isSettingsPage || isMapping || edgeToEdge || isOverview) &&
								'overflow-visible'
						)}
					>
						<Card.Content
							class={cn(
								'flex min-h-0 min-w-0 flex-1 flex-col',
								/* Configuration and Settings run their sections to the title's own
							   leading edge instead of insetting a second time. */
								(edgeToEdge || scrollsUnderTitle) && 'px-0',
								/* Desktop keeps the card's own inset; below the Shell tier
							   the map runs full-bleed like the Workers table does. */
								(isMapping || isOverview) && 'max-lg:px-0'
							)}
						>
							{#if data.worksite || isSettingsPage}
								{@render children()}
							{:else}
								<!-- Almost the only control on the Overview empty shell, so it has
							     to re-enable the pointer the bullseye chart backdrop's pass-through
							     takes away; the page's own controls do the same where they
							     sit. Without this the button is unhittable on /overview. -->
								<section
									class="pointer-events-auto flex flex-1 flex-col items-center justify-center gap-3 text-center"
								>
									<h2 class="text-2xl font-semibold tracking-headline">
										{m.empty_create_worksite_title()}
									</h2>
									<p class="max-w-md text-sm text-muted-foreground">
										{m.empty_create_worksite_body()}
									</p>
									<Button
										onclick={() => void firstWorksite.create()}
										disabled={firstWorksite.creating}
									>
										{m.empty_new_worksite()}
									</Button>
									{#if firstWorksite.error}
										<p role="alert" class="text-sm text-state-error">{firstWorksite.error}</p>
									{/if}
								</section>
							{/if}
						</Card.Content>
					</Card.Root>
				</div>
			</div>
			<!-- The chart backdrop is mounted after the page so the Overview's own heading and
		     controls come first in tab order; its absolute, negative stacking keeps it
		     behind them with no visual change. -->
			{#if chartBackdropShown}
				<BullseyeBase
					workers={data.workers}
					attributes={data.attributes}
					zoom={chartBackdrop.zoom}
					entranceAnimationState={isOverview ? overviewEntranceAnimation.state : 'idle'}
					entranceAnimationElapsed={overviewEntranceAnimation.elapsed}
				/>
				<p
					class="pointer-events-none absolute right-32 bottom-7 z-[4] text-xs text-ink-2"
					data-bullseye-label
				>
					{m.overview_bullseye_label()}
				</p>
				<OverviewEdgeControl />
			{/if}
		</Sidebar.Inset>
	</Sidebar.Provider>
</Tooltip.Provider>

<UnsavedChangesDialog guard={unsaved} />
