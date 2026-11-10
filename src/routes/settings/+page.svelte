<script lang="ts">
	/*
	 * Settings. The page owns the section index and its scroll-follow, the section search,
	 * the save state and the installation's runtime reading; each section is a well under
	 * #lib/features/settings/wells. Order: working data and recovery, appearance, the
	 * installation, then the collapsed Not available yet group and Reset last. Theme,
	 * Density, the Accessibility controls, the Date and Time formats, Language and Reset
	 * are live through the app-settings context, and Export backup writes a copy of the
	 * database through the desktop shell.
	 */
	import { getContext, onMount } from 'svelte';
	import { page } from '$app/state';
	import { dataErrorCopy, type DataErrorCopy } from '#lib/client/data-api.ts';
	import type { RuntimeInfo } from '#lib/client/api-decode.ts';
	import { getRuntimeInfo } from '#lib/client/runtime-api.ts';
	import { appSettingsContextKey, type AppSettingsContext } from '#lib/shared/app-settings.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { RuntimeReading } from '#lib/features/settings/runtime-details.ts';
	import { matchSections } from '#lib/features/settings/settings-search.ts';
	import AboutWell from '#lib/features/settings/wells/about-well.svelte';
	import AccessibilityWell from '#lib/features/settings/wells/accessibility-well.svelte';
	import BackupsWell from '#lib/features/settings/wells/backups-well.svelte';
	import DataWell from '#lib/features/settings/wells/data-well.svelte';
	import DensityWell from '#lib/features/settings/wells/density-well.svelte';
	import DiagnosticsWell from '#lib/features/settings/wells/diagnostics-well.svelte';
	import GeneralWell from '#lib/features/settings/wells/general-well.svelte';
	import PrivacyWell from '#lib/features/settings/wells/privacy-well.svelte';
	import RegionWell from '#lib/features/settings/wells/region-well.svelte';
	import ResetWell from '#lib/features/settings/wells/reset-well.svelte';
	import ShortcutsWell from '#lib/features/settings/wells/shortcuts-well.svelte';
	import ThemeWell from '#lib/features/settings/wells/theme-well.svelte';
	import UnavailableWell from '#lib/features/settings/wells/unavailable-well.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);

	/* ── Navigation ─────────────────────────────────────────────────────────── */

	const sections = $derived([
		{ id: 'data', label: m.settings_data_title() },
		{ id: 'backups', label: m.settings_backups_title() },
		{ id: 'privacy', label: m.settings_privacy_title() },
		{ id: 'theme', label: m.settings_theme_title() },
		{ id: 'density', label: m.settings_density_title() },
		{ id: 'accessibility', label: m.settings_accessibility_title() },
		{ id: 'region', label: m.settings_region_title() },
		{ id: 'general', label: m.settings_general_title() },
		{ id: 'diagnostics', label: m.settings_diagnostics_title() },
		{ id: 'shortcuts', label: m.settings_shortcuts_title() },
		{ id: 'about', label: m.settings_about_nav() },
		{ id: 'unavailable', label: m.settings_not_available() },
		{ id: 'reset', label: m.settings_reset_title() }
	] as const);

	/* ── Search ─────────────────────────────────────────────────────────────── */

	let query = $state('');
	let unavailableOpen = $state(false);
	/* The wells' own text, read when the query changes: the wells are the one source of
	   what each section says, so the search cannot drift from the page. */
	let wellText = $state<Record<string, string>>({});

	function readWellText() {
		wellText = Object.fromEntries(
			Array.from(document.querySelectorAll<HTMLElement>('[data-well]')).map((well) => [
				well.id,
				well.textContent ?? ''
			])
		);
	}

	const matches = $derived(
		matchSections(
			query,
			sections.map((section) => ({ ...section, text: wellText[section.id] ?? '' }))
		)
	);
	const searching = $derived(query.trim() !== '');

	function jumpTo(id: string) {
		if (id === 'unavailable') unavailableOpen = true;
		selectSection(id);
		document.getElementById(id)?.scrollIntoView({ block: 'start' });
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && matches[0]) {
			event.preventDefault();
			jumpTo(matches[0].id);
		} else if (event.key === 'Escape' && query) {
			event.preventDefault();
			query = '';
		}
	}

	let activeSection = $state<string>('data');
	/* A click is a choice the scroll position cannot always express: the last cards are
	   shorter than the scroll left under them, so they cannot bring their own top to the
	   reading line. The click holds until the reader scrolls. */
	let pinnedSection: string | null = null;

	/* The page scrolls inside the shell, not the window, so the index measures against that
	   scroller and listens for scroll in the capture phase. The wells do not change on this
	   page, so the list is read once, and one measurement per frame is enough: scroll events
	   can arrive faster than the reader can see the index move. */
	const readingLine = 160;

	function selectSection(id: string) {
		pinnedSection = id;
		activeSection = id;
	}

	onMount(() => {
		const viewport = document.querySelector<HTMLElement>('[data-scroll-viewport]');
		const wells = Array.from(document.querySelectorAll<HTMLElement>('[data-well]'));

		/* The index follows the reader: the last well whose top has passed the reading line is
		   current. The last cards are shorter than the scroll left under them, so their tops
		   never reach the fixed line; over that final stretch the line slides down with them,
		   so each one still gets its turn. */
		function followReader() {
			if (pinnedSection || !viewport) return;

			const last = wells[wells.length - 1];
			if (!last) return;

			const max = viewport.scrollHeight - viewport.clientHeight;
			const remaining = max - viewport.scrollTop;
			/* How far the last well's top lands below the line at the foot of the page. */
			const slack = last.getBoundingClientRect().top - remaining - readingLine;

			const line =
				max > 0 && slack > 0
					? readingLine + Math.min(Math.max(slack - remaining, 0), slack)
					: readingLine;

			let current = wells[0]?.id ?? 'data';
			for (const well of wells) {
				if (well.getBoundingClientRect().top <= line + 1) current = well.id;
			}
			activeSection = current;
		}

		let frame = 0;
		function scheduleFollowReader() {
			if (frame !== 0) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				followReader();
			});
		}

		followReader();
		void loadRuntime();
		window.addEventListener('scroll', scheduleFollowReader, { capture: true, passive: true });

		/* Density changes the scroller's own height and the wells' heights change as their
		   contents resolve, so the index has to re-measure when the scroller or the page
		   inside it changes size. */
		const resize = new ResizeObserver(scheduleFollowReader);
		if (viewport) {
			resize.observe(viewport);
			for (const child of viewport.children) resize.observe(child);
		}

		/* Any input that can move the page takes the index back from a link click. The
		   link's own pointerdown releases the old pin before the click sets the new one. */
		const releasePin = () => (pinnedSection = null);
		const releaseOn = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
		for (const type of releaseOn) {
			window.addEventListener(type, releasePin, { capture: true, passive: true });
		}

		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('scroll', scheduleFollowReader, { capture: true });
			for (const type of releaseOn) {
				window.removeEventListener(type, releasePin, { capture: true });
			}
			resize.disconnect();
		};
	});

	/* The running installation's identity, shared by Diagnostics and About. A failed read
	   keeps its error, so the wells can say the read failed instead of pretending each value
	   is simply unavailable. */
	let runtimeValue = $state<RuntimeInfo | null>(null);
	let runtimeLoading = $state(true);
	let runtimeError = $state<DataErrorCopy | null>(null);
	const runtime = $derived<RuntimeReading>({
		value: runtimeValue,
		loading: runtimeLoading,
		error: runtimeError
	});

	async function loadRuntime(): Promise<void> {
		runtimeLoading = true;
		runtimeError = null;
		try {
			runtimeValue = await getRuntimeInfo();
		} catch (error) {
			runtimeError = dataErrorCopy(error, m.settings_data_error_read_details());
		} finally {
			runtimeLoading = false;
		}
	}
</script>

<div class="grid w-full gap-6 lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-start lg:gap-10">
	<!-- The index follows the reader and narrows to the search. Below the desktop split
	     the page is a single column; the search results stand in for the index there. -->
	<nav aria-label={m.settings_sections_nav()} class="sticky top-12 hidden pt-1 lg:block">
		<ul class="grid gap-0.5">
			{#each matches as section (section.id)}
				<li>
					<a
						href="#{section.id}"
						aria-current={activeSection === section.id ? 'location' : undefined}
						onclick={(event) => {
							event.preventDefault();
							jumpTo(section.id);
						}}
						class="block rounded-control px-3 py-1.5 text-sm text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid aria-[current=location]:bg-panel aria-[current=location]:font-medium aria-[current=location]:text-ink aria-[current=location]:shadow-surface"
					>
						{section.label}
					</a>
				</li>
			{/each}
		</ul>
	</nav>

	<div class="grid max-w-3xl min-w-0 gap-6" aria-busy={settings.saving}>
		<div class="grid gap-2">
			<p class="text-sm text-ink-3">{m.settings_scope_note()}</p>
			<Input
				type="search"
				bind:value={query}
				oninput={readWellText}
				onfocus={readWellText}
				onkeydown={onSearchKeydown}
				aria-label={m.settings_search_label()}
				placeholder={m.settings_search_label()}
				data-settings-search
			/>
			{#if searching}
				<ul class="flex flex-wrap gap-2 lg:hidden" aria-label={m.settings_search_results()}>
					{#each matches as section (section.id)}
						<li>
							<a
								href="#{section.id}"
								onclick={(event) => {
									event.preventDefault();
									jumpTo(section.id);
								}}
								class="block rounded-control px-3 py-1.5 text-sm text-ink-2 shadow-surface hover:bg-hover"
								>{section.label}</a
							>
						</li>
					{/each}
				</ul>
				{#if matches.length === 0}
					<p class="text-sm text-ink-3" role="status">{m.settings_search_none()}</p>
				{/if}
			{/if}
			{#if settings.saving}
				<p class="text-sm text-ink-3" aria-live="polite" data-save-status>
					{m.settings_saving()}
				</p>
			{/if}
		</div>

		<!-- ── Data and recovery ── -->
		<DataWell />
		<BackupsWell />
		<PrivacyWell encrypted={page.data.boot.state === 'open' && page.data.boot.encrypted} />

		<!-- ── Appearance and accessibility ── -->
		<ThemeWell />
		<DensityWell />
		<AccessibilityWell />
		<RegionWell />

		<!-- ── This installation ── -->
		<GeneralWell />
		<DiagnosticsWell {runtime} />
		<ShortcutsWell />
		<AboutWell {runtime} />

		<!-- ── Not available yet, then Reset ── -->
		<UnavailableWell bind:open={unavailableOpen} />
		<ResetWell />
	</div>
</div>
