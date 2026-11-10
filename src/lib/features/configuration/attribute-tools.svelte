<script lang="ts">
	import PlusIcon from '@lucide/svelte/icons/plus';
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { AttributeDraft } from './attribute-draft.ts';
	import type { AttributePlacement } from './attribute-placement.svelte.ts';

	/**
	 * The everyday answer editor for one Attribute.
	 */
	type Props = {
		attribute: AttributeDraft;
		saving: boolean;
		onAddOption: (attribute: AttributeDraft, parentId?: string) => string | null;
		placement: AttributePlacement;
	};

	let { attribute, saving, onAddOption, placement }: Props = $props();
</script>

<div class="mr-7 ml-4 grid gap-4 border-l border-rule py-1 pl-2" data-testid="attribute-tools">
	<div class="grid gap-2">
		<Field.Field orientation="horizontal" class="items-center gap-1 pr-1 pl-8">
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				class="size-7 shrink-0 p-0 coarse:size-tap"
				aria-label={m.configuration_add_option_button({
					name: attribute.name || m.configuration_attribute_fallback()
				})}
				disabled={saving}
				onclick={() => onAddOption(attribute, '')}
			>
				<PlusIcon class="size-4" />
			</Button>
			<Field.Field class="min-w-0 flex-1">
				<Field.Label class="sr-only" for={`${attribute.id}-new-option`}>
					{m.configuration_add_option_to({
						name: attribute.name || m.configuration_attribute_fallback()
					})}
				</Field.Label>
				<Input
					id={`${attribute.id}-new-option`}
					bind:value={attribute.newOption}
					class={`min-h-tap border-0 bg-transparent px-1 text-sm shadow-none placeholder:text-ink focus-visible:bg-inset md:min-h-8 ${placement.isDraggingPending(attribute.id) ? 'opacity-40' : ''}`}
					placeholder={m.configuration_add_option_placeholder()}
					aria-invalid={Boolean(attribute.newOptionError)}
					aria-describedby={attribute.newOptionError
						? `${attribute.id}-new-option-error`
						: undefined}
					oninput={() => (attribute.newOptionError = '')}
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							onAddOption(attribute, '');
						}
					}}
				/>
				{#if attribute.newOptionError}
					<Field.Error id={`${attribute.id}-new-option-error`}
						>{attribute.newOptionError}</Field.Error
					>
				{/if}
			</Field.Field>
			{#if attribute.newOption.trim()}
				<button
					type="button"
					data-placement-handle={`pending-${attribute.id}`}
					class="flex size-7 shrink-0 touch-none items-center justify-center rounded-sm text-ink-3 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring coarse:size-tap"
					class:cursor-grabbing={placement.isDraggingPending(attribute.id)}
					aria-label={m.configuration_placement_pending_handle({
						name: attribute.newOption.trim()
					})}
					aria-pressed={placement.source?.kind === 'pending' &&
						placement.source.attributeId === attribute.id}
					disabled={saving}
					onpointerdown={(event) =>
						placement.pointerDown(event, {
							kind: 'pending',
							attributeId: attribute.id,
							value: attribute.newOption.trim()
						})}
					onclick={() =>
						placement.clickHandle({
							kind: 'pending',
							attributeId: attribute.id,
							value: attribute.newOption.trim()
						})}><GripVerticalIcon class="size-4" /></button
				>
			{/if}
		</Field.Field>
	</div>
</div>
