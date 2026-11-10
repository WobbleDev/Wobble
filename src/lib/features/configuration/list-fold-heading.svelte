<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { m } from '#lib/paraglide/messages.js';
	import OutlineCount from './outline-count.svelte';

	/**
	 * A value list's pinned heading: the title folds the list, and the summary is how many
	 * distinct Workers hold at least one of its values.
	 */
	type Props = {
		title: string;
		open: boolean;
		/** The id of the folded region. */
		controls: string;
		holders: number;
		onToggle: () => void;
	};

	let { title, open, controls, holders, onToggle }: Props = $props();
</script>

<div class="sticky top-0 z-10 -mx-6 flex items-center gap-2 bg-panel px-6 pt-6 pb-1">
	<button
		type="button"
		class="flex min-h-9 min-w-0 flex-1 items-center gap-1 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-tap"
		aria-expanded={open}
		aria-controls={controls}
		aria-label={m.configuration_list_toggle({ name: title })}
		onclick={onToggle}
	>
		<ChevronDownIcon
			aria-hidden="true"
			class={`size-4 shrink-0 text-ink-3 transition-transform ${open ? '' : '-rotate-90'}`}
		/>
		<h2 class="section-title">{title}</h2>
	</button>
	<div class="w-14 shrink-0" data-testid="list-holders">
		<OutlineCount testId="list-worker-count" count={holders} />
	</div>
</div>
