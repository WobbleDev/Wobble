<script lang="ts">
	/**
	 * Needs review: a saved view that names something the Worksite no longer holds. Each
	 * reference is dropped or the whole open is cancelled; the view opens only once none is
	 * left, and the stored view stays as it was until an explicit Update.
	 */
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Dialog from '#lib/components/ui/dialog/index.ts';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { problemPlace, problemReading } from './view-problem-copy.ts';
	import type { SavedViews } from './saved-views.svelte.ts';

	type Props = {
		views: SavedViews;
		attributes: readonly WorkerAttributeDefinition[];
	};
	let { views, attributes }: Props = $props();

	const review = $derived(views.review);
</script>

<Dialog.Root
	open={review !== null}
	onOpenChange={(open) => {
		if (!open) views.cancelReview();
	}}
>
	<Dialog.Content data-testid="view-review">
		{#if review}
			<Dialog.Header>
				<Dialog.Title>{m.views_review_title({ name: review.view.name })}</Dialog.Title>
			</Dialog.Header>
			<ul class="flex flex-col gap-2" aria-label={m.views_review_list()}>
				{#each review.problems as problem (problem.key)}
					<li
						class="flex items-center justify-between gap-3 rounded-surface border border-rule px-3 py-2"
						data-testid="view-problem"
					>
						<span class="min-w-0 text-sm">
							<span class="font-medium">{problemPlace(problem)}</span>
							<span class="text-muted-foreground"> · {problemReading(problem, attributes)}</span>
						</span>
						<Button
							variant="outline"
							size="sm"
							data-testid="view-problem-drop"
							onclick={() => views.drop(problem.key)}
						>
							{m.views_review_drop()}
						</Button>
					</li>
				{/each}
			</ul>
			<Dialog.Footer>
				<Button variant="ghost" onclick={() => views.cancelReview()}>
					{m.views_review_cancel()}
				</Button>
				<Button
					disabled={review.problems.length > 0}
					data-testid="view-review-open"
					onclick={() => views.confirmReview()}
				>
					{m.views_review_open()}
				</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
