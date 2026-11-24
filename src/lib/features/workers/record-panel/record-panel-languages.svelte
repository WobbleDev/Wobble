<script lang="ts">
	/**
	 * Languages as chips, in the same style as Agitations: only the ones this Worker
	 * speaks, each with a × that removes it, and an Add language menu that offers the
	 * Worksite's other Languages. Either way the whole list is written at once and
	 * reported through the status line, whose Undo puts the previous list back.
	 */
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import { runSingleEdit } from '../data-table/bulk-actions/bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/features.ts';
	import type { Language, Worker } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';

	let {
		worker,
		languages,
		headingId,
		onUpdate,
		refresh,
		onSaved
	}: {
		worker: Worker;
		languages: readonly Language[];
		headingId: string;
		/** Bound to this Worker by the panel: writes the whole Language list. */
		onUpdate: (languageIds: string[]) => Promise<void>;
		refresh: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
	} = $props();

	let saving = $state(false);
	let heading = $state<HTMLHeadingElement | null>(null);

	/** The Worksite's Languages this Worker speaks, in the Worksite's order. */
	const spoken = $derived(languages.filter((language) => worker.languages.includes(language.id)));
	/** The ones still to add. */
	const available = $derived(
		languages.filter((language) => !worker.languages.includes(language.id))
	);

	/** Writes the list with one Language added or taken out. */
	async function change(language: Language, add: boolean) {
		if (saving) return;
		// Read now: the selection can move before the status line's Undo runs.
		const previous = [...worker.languages];
		const next = add ? [...previous, language.id] : previous.filter((id) => id !== language.id);
		const write = onUpdate;

		saving = true;
		const report = await runSingleEdit({
			apply: () => write(next),
			restore: () => write(previous),
			refresh,
			summary: m.workers_languages_saved({ name: worker.name }),
			fallback: m.workers_languages_failed()
		});
		saving = false;
		onSaved?.(report);

		// The × that was just pressed is gone with the chip, so focus moves up.
		if (!add && !report.error) heading?.focus();
	}
</script>

<section aria-labelledby={headingId} class="grid grid-cols-[minmax(0,1fr)] gap-3">
	<h3 id={headingId} bind:this={heading} tabindex="-1" class="label">
		{m.workers_languages_heading()}
	</h3>
	{#if spoken.length}
		<ul class="flex flex-wrap gap-2">
			{#each spoken as language (language.id)}
				<li class="flex h-7 max-w-full items-center rounded-item bg-inset text-sm">
					<span class="prose-value min-w-0 truncate pr-1 pl-2" title={language.name}
						>{language.name}</span
					>
					<!-- Kept raw: the remove control is joined to the chip's right edge; the ui Button's radius and border break that join. -->
					<button
						type="button"
						class="flex h-full shrink-0 items-center rounded-r-item px-1.5 text-ink-3 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
						aria-label={m.workers_language_remove({ name: language.name })}
						disabled={saving}
						onclick={() => void change(language, false)}
					>
						<XIcon class="size-3.5" />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if languages.length === 0}
		<p class="text-sm text-ink-3">{m.workers_languages_none()}</p>
	{:else if available.length}
		<!-- A menu over the panel, so opening it moves nothing. -->
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						type="button"
						variant="ghost"
						size="sm"
						class="min-h-tap justify-self-start lg:min-h-8"
						disabled={saving}
					>
						<PlusIcon class="size-4" />
						{m.workers_language_add()}
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="max-h-64 overflow-y-auto">
				{#each available as language (language.id)}
					<DropdownMenu.Item onSelect={() => void change(language, true)}>
						{language.name}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/if}
</section>
