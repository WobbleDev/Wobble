<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.ts';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { m } from '#lib/paraglide/messages.js';
	let {
		start,
		end,
		total,
		page,
		pageCount,
		previousLabel,
		nextLabel,
		pageLabel,
		onprevious,
		onnext,
		visible = true,
		element = $bindable()
	}: {
		start: number;
		end: number;
		total: number;
		page: number;
		pageCount: number;
		previousLabel: string;
		nextLabel: string;
		pageLabel: string;
		onprevious: (button: HTMLElement) => void;
		onnext: (button: HTMLElement) => void;
		visible?: boolean;
		element?: HTMLElement;
	} = $props();
</script>

<div
	bind:this={element}
	data-group-pager
	class="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-rule pt-2 {visible
		? ''
		: 'invisible absolute inset-x-0 bottom-0'}"
	inert={!visible}
	aria-hidden={!visible ? 'true' : undefined}
>
	<span class="font-mono text-xs text-ink-3 tabular-nums" aria-live="polite" aria-atomic="true">
		<span class="sr-only"
			>{pageLabel}
			<span data-page-position
				>{m.overview_agitations_page({ current: page + 1, total: pageCount })}</span
			>.
		</span>
		<span class="whitespace-nowrap uppercase" data-group-range
			>{m.overview_groups_range({ start, end, total })}</span
		>
	</span>
	<div class="ml-auto flex shrink-0 items-center gap-1">
		<Button
			variant="ghost"
			size="sm"
			class="min-h-tap px-2 md:min-h-8"
			disabled={page === 0}
			aria-label={previousLabel}
			onclick={(event) => onprevious(event.currentTarget)}
			><ChevronLeftIcon class="size-4" aria-hidden="true" /><span class="pager-label"
				>{m.overview_groups_previous()}</span
			></Button
		>
		<Button
			variant="ghost"
			size="sm"
			class="min-h-tap px-2 md:min-h-8"
			disabled={page >= pageCount - 1}
			aria-label={nextLabel}
			onclick={(event) => onnext(event.currentTarget)}
			><span class="pager-label">{m.overview_agitations_next()}</span><ChevronRightIcon
				class="size-4"
				aria-hidden="true"
			/></Button
		>
	</div>
</div>

<style>
	/* A narrow card keeps the pager on one line: the arrows carry their aria-labels. */
	@container (width < 21rem) {
		.pager-label {
			display: none;
		}
	}
	@media (pointer: coarse) {
		[data-group-pager] :global(button) {
			min-height: var(--tap-target);
		}
	}
</style>
