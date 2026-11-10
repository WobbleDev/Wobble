<script lang="ts">
	import { committeeTargetMaximum, committeeTargetMinimum } from '#lib/domain-vocabulary.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { m } from '#lib/paraglide/messages.js';

	type Props = {
		committeeTarget?: string;
		error: string;
		saving: boolean;
	};

	let { committeeTarget = $bindable(''), error, saving }: Props = $props();

	/**
	 * The target reads as one sentence with the number in place of the word itself,
	 * so the input sits where `{count}` would be. A marker no translation can
	 * contain splits the sentence around it and never reaches the DOM.
	 */
	const COUNT_MARKER = '\u2063';
	const sentence = $derived(String(m.configuration_committee_line({ count: COUNT_MARKER })));
	const [beforeCount, afterCount] = $derived(sentence.split(COUNT_MARKER));
</script>

<!--
  The Committee coverage target is a property of the Worksite, so it reads as a
  sentence directly beneath the Worksite name rather than as a section of its own.
  The input holds the sentence's number, keeping the same id, label, 1–100 rule and
  error handling the standalone field had.
-->
<div class="grid max-w-md gap-1">
	<label class="sr-only" for="committee-target">{m.configuration_committee_field()}</label>
	<div class="flex flex-wrap items-center gap-2 text-sm text-ink-2">
		<span>{beforeCount}</span>
		<Input
			id="committee-target"
			type="number"
			min={committeeTargetMinimum}
			max={committeeTargetMaximum}
			step="1"
			value={committeeTarget}
			oninput={(event) => (committeeTarget = event.currentTarget.value)}
			class="min-h-tap w-20 md:min-h-(--control-h)"
			aria-invalid={Boolean(error)}
			aria-describedby={error ? 'committee-target-error' : undefined}
			disabled={saving}
		/>
		<span>{afterCount}</span>
	</div>
	{#if error}
		<p id="committee-target-error" class="text-sm text-state-error" role="alert">
			{error}
		</p>
	{/if}
</div>
