<script lang="ts">
	/**
	 * Languages as toggles: every Worksite Language, pressed when this Worker speaks
	 * it. A press writes the whole list at once and reports through the status line,
	 * whose Undo puts the previous list back.
	 */
	import { Button } from '#lib/components/ui/button/index.ts';
	import { runSingleEdit } from '../data-table/data-table-bulk-actions.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
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

	async function toggle(language: Language) {
		if (saving) return;
		// Read now: the selection can move before the status line's Undo runs.
		const previous = [...worker.languages];
		const next = previous.includes(language.id)
			? previous.filter((id) => id !== language.id)
			: [...previous, language.id];
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
	}
</script>

<section aria-labelledby={headingId} class="grid gap-3">
	<h3 id={headingId} class="label">{m.workers_languages_heading()}</h3>
	{#if languages.length}
		<ul class="flex flex-wrap gap-2">
			{#each languages as language (language.id)}
				{@const held = worker.languages.includes(language.id)}
				<li>
					<Button
						type="button"
						variant={held ? 'secondary' : 'outline'}
						size="sm"
						class="min-h-tap lg:min-h-8"
						aria-pressed={held}
						disabled={saving}
						onclick={() => void toggle(language)}
					>
						{language.name}
					</Button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-sm text-ink-3">{m.workers_languages_none()}</p>
	{/if}
</section>
