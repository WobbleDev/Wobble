<script lang="ts">
	/**
	 * What the map shows when nobody is drawn: why, and the one action whose reset scope
	 * matches the cause. An empty Worksite routes to Workers, filters that leave nobody
	 * clear the filters, and an empty Isolate exits Isolate.
	 */
	import { resolve } from '$app/paths';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { MapEmptyKind } from './map-scope.ts';

	let {
		kind,
		hiddenCount,
		activeFilterLabels,
		isolateName,
		onClearFilters,
		onExitIsolate
	}: {
		kind: MapEmptyKind;
		hiddenCount: number;
		activeFilterLabels: readonly string[];
		/** The Isolate focus, when it can still be named. */
		isolateName: string | undefined;
		onClearFilters: () => void;
		onExitIsolate: () => void;
	} = $props();

	const actionClass =
		'min-h-tap border-rule-strong bg-panel hover:bg-hover md:min-h-9 dark:bg-panel dark:hover:bg-hover';
</script>

<div
	class="pointer-events-none absolute inset-0 z-10 grid place-items-center p-6"
	data-testid="map-empty-state"
	data-kind={kind}
>
	<div class="pointer-events-auto flex max-w-sm flex-col items-center gap-3 text-center">
		{#if kind === 'worksite'}
			<p class="text-sm text-ink">{m.mapping_empty_worksite()}</p>
			<Button variant="outline" size="sm" class={actionClass} href={resolve('/workers')}>
				{m.mapping_add_first_worker()}
			</Button>
		{:else if kind === 'isolate'}
			<p class="text-sm text-ink">
				{isolateName
					? m.mapping_empty_isolate_named({ name: isolateName })
					: m.mapping_empty_isolate()}
			</p>
			<Button variant="outline" size="sm" class={actionClass} onclick={onExitIsolate}>
				{m.mapping_exit_isolate()}
			</Button>
		{:else}
			<p class="text-sm text-ink">{m.mapping_no_workers_match()}</p>
			{#if hiddenCount > 0}
				<p class="label num text-ink-3">
					{activeFilterLabels.length > 0
						? m.mapping_hidden_by_filters({
								count: hiddenCount,
								filters: activeFilterLabels.join(', ')
							})
						: m.mapping_hidden_by_current({ count: hiddenCount })}
				</p>
			{/if}
			<Button variant="outline" size="sm" class={actionClass} onclick={onClearFilters}>
				{m.mapping_clear_filters()}
			</Button>
		{/if}
	</div>
</div>
