<script lang="ts">
	import ChoiceSelect from '#lib/shared/choice-select.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import { fieldExampleOptions } from './field-example.ts';

	/** Draft definition in, nothing out: the pick stays local and writes no Worker. */
	type Props = { attribute: WorkerAttributeDefinition };

	let { attribute }: Props = $props();
	let picked = $state('');
	const options = $derived(fieldExampleOptions(attribute));
	const name = $derived(attribute.name || m.configuration_attribute_fallback());
</script>

{#if options.length > 0}
	<div class="grid gap-1 pr-1 pl-8" data-testid="field-example">
		<ChoiceSelect
			aria-label={m.configuration_field_example_aria({ name })}
			placeholder={m.configuration_field_example_placeholder({ name })}
			items={options}
			value={options.some((option) => option.value === picked) ? picked : ''}
			onChange={(next) => (picked = next)}
		/>
	</div>
{/if}
