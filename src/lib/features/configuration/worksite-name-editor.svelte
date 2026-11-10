<script lang="ts">
	import { tick } from 'svelte';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { m } from '#lib/paraglide/messages.js';

	type Props = {
		name?: string;
		savedName: string;
		editing?: boolean;
		saving: boolean;
		dirty: boolean;
	};

	let {
		name = $bindable(''),
		savedName,
		editing = $bindable(false),
		saving,
		dirty
	}: Props = $props();

	// Focus once the field has mounted, rather than via `autofocus`, which the browser
	// ignores (and logs) when another element already holds focus. Selecting the whole
	// name is the macOS rename convention.
	let input = $state<HTMLInputElement | null>(null);
	let nameButton = $state<HTMLButtonElement | null>(null);
	$effect(() => {
		input?.focus();
		input?.select();
	});

	const displayName = $derived(name || m.configuration_untitled_worksite());

	/**
	 * Closes the field and hands focus back to the name control, which replaces the input
	 * that held it. A blur that lands on another control keeps that control's focus; an
	 * explicit keyboard exit always comes back here.
	 */
	function finishEditing(restoreFocus = false) {
		editing = false;
		void tick().then(() => {
			if (restoreFocus || document.activeElement === document.body) nameButton?.focus();
		});
	}
</script>

<!-- The worksite's name is the page's own title, so it sits on the pad itself
     rather than in a section: there is nothing above it to step down from. -->
<div class="flex min-w-0 flex-wrap items-center gap-2">
	{#if editing}
		<Input
			bind:value={name}
			class="min-h-tap w-72 max-w-full text-xl font-semibold tracking-title md:min-h-(--control-h)"
			aria-label={m.configuration_worksite_name()}
			bind:ref={input}
			disabled={saving}
			onblur={() => finishEditing()}
			onkeydown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					finishEditing(true);
				}
				if (event.key === 'Escape') {
					name = savedName;
					finishEditing(true);
				}
			}}
		/>
	{:else}
		<!-- Kept raw: the name is styled as a heading and wraps; the ui Button sets its own text size, weight and nowrap. -->
		<button
			bind:this={nameButton}
			type="button"
			class="-ml-1 flex min-h-tap max-w-full min-w-0 flex-wrap items-center gap-2 rounded-control px-1 text-xl font-semibold tracking-title hover:bg-hover md:min-h-0"
			aria-label={m.configuration_edit_worksite_name({ name: displayName })}
			disabled={saving}
			onclick={() => (editing = true)}
		>
			{displayName}
			<PencilIcon class="size-3.5 text-ink-3" />
		</button>
	{/if}
	{#if dirty}
		<Badge variant="secondary" class="rounded-item font-mono tracking-key uppercase"
			>{m.configuration_unsaved()}</Badge
		>
	{/if}
	{#if dirty && !name.trim()}
		<p class="text-sm text-state-error" role="alert">{m.configuration_worksite_name_required()}</p>
	{/if}
</div>
