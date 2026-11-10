<script lang="ts">
	/**
	 * A server-render host for components that open tooltips: it supplies the
	 * Tooltip.Provider context the components expect, then renders the component it is
	 * given. Specs use it with svelte/server, where no route shell exists.
	 */
	import type { Component } from 'svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';

	/* A component of any props type: the host forwards the props it is given. */
	let { component, props }: { component: Component<never>; props: Record<string, unknown> } =
		$props();
	const Inner = $derived(component as unknown as Component<Record<string, unknown>>);
</script>

<Tooltip.Provider>
	<Inner {...props} />
</Tooltip.Provider>
