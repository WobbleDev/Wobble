<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { Button } from '#lib/components/ui/button/index.ts';
	import SwatchDot from '#lib/shared/swatch-dot.svelte';
	import { assessmentColorFor } from '#lib/shared/assessment.ts';
	import { assessmentLabel } from '#lib/i18n/assessment.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { resolve } from '$app/paths';
	import type { Language, Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { answerDisplay } from './layout/graph-analysis.ts';
	import { answerValueReading } from '#lib/shared/no-value-reading.ts';

	type Neighbour = {
		id: string;
		name: string;
		assessment: Worker['assessment'];
		relationshipCount: number;
	};

	type Props = {
		worker: Worker;
		neighbours: readonly Neighbour[];
		attributes: readonly WorkerAttributeDefinition[];
		languages: readonly Language[];
		isolated: boolean;
		onSelectNeighbour: (workerId: string) => void;
		onIsolate: () => void;
		/** Runs before the link navigates: hands the Worker to the Workers view in memory. */
		onOpenInWorkers: () => void;
		onClose: () => void;
		/** At lg the card floats in the free canvas between the control strip and the bottom bar. */
		dockTop: number;
		dockBottom: number;
	};

	let {
		worker,
		neighbours,
		attributes,
		languages,
		isolated,
		onSelectNeighbour,
		onIsolate,
		onOpenInWorkers,
		onClose,
		dockTop,
		dockBottom
	}: Props = $props();

	/* The recorded Languages, in the Worksite's vocabulary order. The Worker record is
	   the source; nothing here infers a Language from another field (L1). */
	const recordedLanguages = $derived(
		languages
			.filter((language) => worker.languages.includes(language.id))
			.map((language) => language.name)
	);
</script>

<section
	class="flex shrink-0 flex-col gap-4 border-t border-rule bg-panel p-4 lg:absolute lg:top-(--dock-top) lg:right-3 lg:z-20 lg:max-h-[calc(100%-var(--dock-top)-var(--dock-bottom))] lg:w-80 lg:overflow-y-auto lg:rounded-surface lg:border-0 lg:shadow-surface"
	data-scroll-region
	aria-label={m.mapping_worker_record()}
	style:--dock-top="{dockTop}px"
	style:--dock-bottom="{dockBottom}px"
>
	<header class="flex items-start justify-between gap-3">
		<div class="min-w-0">
			<h2 class="title prose-value text-ink">{worker.name}</h2>
			<p class="label num mt-1 flex items-center gap-2 text-ink-3">
				<SwatchDot color={assessmentColorFor(worker.assessment)} />
				{neighbours.length === 1
					? m.mapping_worker_meta_one({
							assessment: assessmentLabel(worker.assessment),
							count: neighbours.length
						})
					: m.mapping_worker_meta_other({
							assessment: assessmentLabel(worker.assessment),
							count: neighbours.length
						})}
			</p>
		</div>
		<Button
			variant="ghost"
			size="icon-sm"
			class="size-tap shrink-0 p-0 hover:bg-hover md:size-9"
			aria-label={m.mapping_close_worker_record()}
			onclick={onClose}
		>
			<XIcon />
		</Button>
	</header>

	<dl class="flex flex-col gap-2">
		{#each attributes as attribute (attribute.id)}
			<div class="flex min-w-0 items-baseline justify-between gap-3">
				<dt class="label shrink-0 text-ink-3">{attribute.name}</dt>
				<dd class="prose-value min-w-0 text-right text-sm text-ink">
					{answerValueReading(attribute, answerDisplay(attribute, worker.attributes))}
				</dd>
			</div>
		{/each}
		<div class="flex min-w-0 items-baseline justify-between gap-3">
			<dt class="label shrink-0 text-ink-3">{m.domain_languages()}</dt>
			<dd class="prose-value min-w-0 text-right text-sm text-ink">
				{#if recordedLanguages.length > 0}
					{recordedLanguages.join(', ')}
				{:else}
					{m.mapping_no_languages_recorded()}
				{/if}
			</dd>
		</div>
	</dl>

	{#if neighbours.length > 0}
		<div class="flex flex-col gap-2">
			<p class="label text-ink-3">{m.domain_relationships()}</p>
			<ul class="flex max-h-48 flex-col gap-1 overflow-y-auto">
				{#each neighbours as neighbour (neighbour.id)}
					<li>
						<!-- Kept raw: a full-width neighbour row with a swatch and a trailing count; no ui control is a list row. -->
						<button
							type="button"
							class="flex min-h-tap w-full items-center gap-2 rounded-item px-2 py-1 text-left text-sm text-ink hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-9"
							onclick={() => onSelectNeighbour(neighbour.id)}
						>
							<SwatchDot color={assessmentColorFor(neighbour.assessment)} />
							<span class="truncate">{neighbour.name}</span>
							<span class="label num ml-auto shrink-0 text-ink-3"
								>{neighbour.relationshipCount}</span
							>
						</button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="flex gap-2">
		<Button
			variant={isolated ? 'default' : 'outline'}
			size="sm"
			class="min-h-tap md:min-h-9"
			aria-pressed={isolated}
			onclick={onIsolate}
		>
			<!-- The name stays "Isolate"; the check and aria-pressed carry the state. -->
			{#if isolated}<CheckIcon aria-hidden="true" />{/if}
			{m.mapping_isolate()}
		</Button>
		<Button
			variant="ghost"
			size="sm"
			class="min-h-tap md:min-h-9"
			href={resolve('/workers')}
			onclick={onOpenInWorkers}
		>
			{m.mapping_open_in_workers()}
		</Button>
	</div>
</section>
