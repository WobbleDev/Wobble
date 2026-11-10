<script lang="ts">
	import type { Snippet } from 'svelte';

	/*
	 * One section of the Settings pad. The same recessed well the real
	 * page uses; rows inside it are separated by rules, so a section with five
	 * settings reads as one thing with five lines, not five cards.
	 */
	let {
		id,
		title,
		description,
		children
	}: { id: string; title: string; description?: string; children: Snippet } = $props();
</script>

<section
	{id}
	data-well
	aria-labelledby="{id}-heading"
	class="grid scroll-mt-6 rounded-surface bg-panel shadow-surface"
>
	<header class="grid gap-1 p-6 pb-4">
		<h2 id="{id}-heading" class="section-title">{title}</h2>
		{#if description}
			<p class="max-w-prose text-sm text-ink-3">{description}</p>
		{/if}
	</header>
	{@render children()}
</section>
