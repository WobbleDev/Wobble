<script lang="ts">
	import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { AttributeDraft } from './attribute-draft.ts';
	import type { AttributePlacement } from './attribute-placement.svelte.ts';

	/**
	 * The everyday answer editor for one Attribute: an always-ready, flush-left value
	 * composer at the foot of its values. Each value row opens its own child composer.
	 */
	type Props = {
		attribute: AttributeDraft;
		saving: boolean;
		onAddOption: (attribute: AttributeDraft, parentId?: string, value?: string) => string | null;
		placement: AttributePlacement;
		/** List and detail: the composer sits under the ruled value table. */
		detail?: boolean;
	};

	let { attribute, saving, onAddOption, placement, detail = false }: Props = $props();

	/** The foot composer's own error, so a child composer's refusal never lands under it. */
	let composerError = $state('');
	const shownError = $derived(
		composerError || (attribute.newOption.trim() ? attribute.newOptionError : '')
	);
	const displayName = $derived(attribute.name || m.configuration_attribute_fallback());

	function submit() {
		const id = onAddOption(attribute, '');
		composerError = id ? '' : attribute.newOptionError;
	}

	function clear() {
		attribute.newOption = '';
		attribute.newOptionError = '';
		composerError = '';
	}
</script>

{#snippet pendingHandle()}
	{#if attribute.newOption.trim()}
		<button
			type="button"
			data-placement-handle={`pending-${attribute.id}`}
			class="flex size-7 shrink-0 touch-none items-center justify-center rounded-sm text-ink-3 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring max-md:size-tap coarse:size-tap"
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
			onclick={(event) =>
				placement.clickHandle(event, {
					kind: 'pending',
					attributeId: attribute.id,
					value: attribute.newOption.trim()
				})}><GripVerticalIcon class="size-4" /></button
		>
	{/if}
{/snippet}

{#snippet composer()}
	<div class="flex min-w-0 items-center gap-2">
		<Field.Field class="min-w-0 flex-1">
			<Field.Label class="sr-only" for={`${attribute.id}-new-option`}>
				{m.configuration_new_value_to({ name: displayName })}
			</Field.Label>
			<Input
				id={`${attribute.id}-new-option`}
				bind:value={attribute.newOption}
				class={`min-h-tap border-transparent bg-transparent px-1 text-sm shadow-none placeholder:text-ink-3 hover:border-rule-strong focus-visible:border-rule-strong md:min-h-8 ${placement.isDraggingPending(attribute.id) ? 'opacity-40' : ''}`}
				placeholder={m.configuration_new_value_placeholder()}
				aria-invalid={Boolean(shownError)}
				aria-describedby={shownError ? `${attribute.id}-new-option-error` : undefined}
				oninput={() => {
					attribute.newOptionError = '';
					composerError = '';
				}}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						submit();
					} else if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						clear();
					}
				}}
			/>
		</Field.Field>
		{@render pendingHandle()}
	</div>
	{#if shownError}
		<Field.Error id={`${attribute.id}-new-option-error`}>{shownError}</Field.Error>
	{/if}
{/snippet}

{#if detail}
	<div class="mt-3 grid gap-1" data-testid="attribute-tools">
		{@render composer()}
	</div>
{:else}
	<div class="grid gap-1 py-1" data-testid="attribute-tools">
		{@render composer()}
	</div>
{/if}
