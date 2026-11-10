<script lang="ts">
	import * as Field from '#lib/components/ui/field/index.ts';
	import * as Select from '#lib/components/ui/select/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { AttributeType } from './attribute-draft.ts';

	const attributeTypeItems = $derived([
		{ value: 'category', label: m.domain_category(), help: m.configuration_single_select_help() },
		{ value: 'tag', label: m.domain_tag(), help: m.configuration_multi_select_help() }
	] satisfies { value: AttributeType; label: string; help: string }[]);

	type Props = {
		id: string;
		/** The visible field label, also the start of the select's accessible name. */
		label: string;
		value?: AttributeType;
	};

	let { id, label, value = $bindable<AttributeType>('category') }: Props = $props();

	const selected = $derived(
		attributeTypeItems.find((item) => item.value === value) ?? attributeTypeItems[0]
	);
	const helpId = $derived(`${id}-help`);
	const helpText = $derived(
		selected.value === 'tag'
			? m.configuration_type_help_tag()
			: m.configuration_type_help_category()
	);
	const accessibleName = $derived(`${label}: ${selected.label}. ${selected.help}`);
</script>

<Select.Root type="single" items={attributeTypeItems} bind:value>
	<Select.Trigger
		{id}
		type="button"
		class="min-h-tap w-full md:min-h-(--control-h)"
		aria-label={accessibleName}
		aria-describedby={helpId}
	>
		<Select.Value placeholder={m.configuration_select_type()} />
	</Select.Trigger>
	<Select.Content>
		<Select.Group>
			{#each attributeTypeItems as item (item.value)}
				<Select.Item value={item.value} label={item.label}>
					<span class="flex flex-col items-start gap-0.5">
						<span>{item.label}</span>
						<span class="text-xs font-normal text-muted-foreground">{item.help}</span>
					</span>
				</Select.Item>
			{/each}
		</Select.Group>
	</Select.Content>
</Select.Root>
<Field.Description id={helpId}>{helpText}</Field.Description>
