<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { AttributeType } from './attribute-draft.ts';
	import AttributeTypeSelect from './attribute-type-select.svelte';

	type Props = {
		name?: string;
		type?: AttributeType;
		nameError: string;
		onNameInput: () => void;
		onCancel: () => void;
		onSubmit: (event: SubmitEvent) => void;
	};
	let {
		name = $bindable(''),
		type = $bindable<AttributeType>('category'),
		nameError,
		onNameInput,
		onCancel,
		onSubmit
	}: Props = $props();
</script>

<!--
  The add form is a well inside the Attributes column, not a card inside a card: the
  column already supplies the panel, so the form takes the recess step and reads as one
  inline editor. Both Attribute types are offered here; the inline type control on each
  row can change it later.
-->
<div class="rounded-item border border-rule bg-inset p-3" data-testid="add-attribute-form">
	<form class="grid gap-3" onsubmit={onSubmit}>
		<div class="grid gap-0.5">
			<h3 class="section-title">{m.configuration_add_attribute_title()}</h3>
			<p class="text-sm text-ink-2">{m.configuration_attribute_form_hint()}</p>
		</div>
		<div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_11rem_auto] md:items-end">
			<Field.Field class="min-w-0">
				<Field.Label for="new-attribute-name" class="field-label"
					>{m.configuration_attribute_display_name()}</Field.Label
				>
				<Input
					id="new-attribute-name"
					bind:value={name}
					{@attach (node) => node.focus()}
					class="min-h-tap md:min-h-(--control-h)"
					aria-invalid={Boolean(nameError)}
					aria-describedby={nameError ? 'new-attribute-name-error' : undefined}
					oninput={onNameInput}
				/>
				{#if nameError}
					<Field.Error id="new-attribute-name-error">{nameError}</Field.Error>
				{/if}
			</Field.Field>
			<Field.Field class="min-w-0">
				<Field.Label for="new-attribute-type" class="field-label"
					>{m.configuration_attribute_type()}</Field.Label
				>
				<AttributeTypeSelect
					id="new-attribute-type"
					label={m.configuration_attribute_type()}
					bind:value={type}
				/>
			</Field.Field>
			<div class="flex gap-2 max-md:flex-col-reverse md:justify-end">
				<Button
					type="button"
					variant="outline"
					class="min-h-tap md:min-h-(--control-h)"
					onclick={onCancel}>{m.common_cancel()}</Button
				>
				<Button type="submit" class="min-h-tap md:min-h-(--control-h)"
					>{m.configuration_add_attribute()}</Button
				>
			</div>
		</div>
	</form>
</div>
