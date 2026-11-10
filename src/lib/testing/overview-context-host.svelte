<script lang="ts">
	/**
	 * A server-render host for components that read the Overview shell's focus and zoom
	 * contexts: it sets both as the shell does, toggles focus when asked, then renders
	 * the component it is given. Specs use it with svelte/server.
	 */
	import type { Component } from 'svelte';
	import { setBullseyeView } from '#lib/features/overview/bullseye/bullseye-view.ts';
	import {
		createOverviewFocus,
		setOverviewFocus
	} from '#lib/features/overview/overview-focus.svelte.ts';

	let {
		component: Inner,
		focused = false,
		zoom = 1,
		shown = false
	}: {
		component: Component<never>;
		focused?: boolean;
		zoom?: number;
		shown?: boolean;
	} = $props();

	const focus = createOverviewFocus({ isOverview: () => true });
	// The host takes its state once, at creation; a later change needs a new host.
	// svelte-ignore state_referenced_locally
	if (focused) focus.toggle();
	setOverviewFocus(focus);
	// svelte-ignore state_referenced_locally
	setBullseyeView({ shown, zoom, setZoom: () => {} });
	const Shown = $derived(Inner as unknown as Component<Record<string, unknown>>);
</script>

<Shown />
