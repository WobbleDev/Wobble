<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';

	type Props = {
		saving: boolean;
		previewing: boolean;
		refreshingData: boolean;
		dirtySections: string[];
		canSave: boolean;
		/** Why Save all is disabled, shown beside it; empty when saving is allowed. */
		blockedReason: string;
		errorMessage: string;
		refreshErrorMessage: string;
		onDiscard: () => void;
		onSave: () => void;
		onRetryRefresh: () => void;
		onDismissError: () => void;
	};

	let {
		saving,
		previewing,
		refreshingData,
		dirtySections,
		canSave,
		blockedReason,
		errorMessage,
		refreshErrorMessage,
		onDiscard,
		onSave,
		onRetryRefresh,
		onDismissError
	}: Props = $props();

	const status = $derived(
		saving
			? refreshingData
				? m.configuration_save_bar_refreshing()
				: m.configuration_save_bar_saving()
			: previewing
				? m.configuration_save_bar_previewing()
				: dirtySections.length
					? m.configuration_save_bar_unsaved()
					: errorMessage
						? m.configuration_save_bar_error()
						: m.configuration_save_bar_saved()
	);
</script>

<!--
  The foot clip.
  Same material as the head clip: the step below the pad, one hairline where it
  meets the paper above it, and the label voice. It is held in the flow at the
  foot of the pad rather than floating over the sections, so it never covers the
  thing you are editing — which is why it takes no shadow and no rounding. The
  negative inline margin is the card's own spacing, so the bar runs edge to edge
  in the pad instead of sitting inset like a second panel.

  The editor holds the bar in a zero-height sticky anchor at the foot of the pad, so it
  stays at the foot of the viewport while the sections above it scroll, and settles
  into the pad's end once the foot is reached. When Save all is disabled, the reason
  sits beside it and names the attribute.
-->
<div
	data-testid="configuration-save-bar"
	class="sticky inset-x-0 bottom-0 -mx-(--card-spacing) flex flex-wrap items-center justify-between gap-3 rounded-b-surface border-t border-rule bg-toolbar px-6 py-3"
>
	<div class="grid min-w-0 gap-0.5">
		<p class="flex flex-wrap items-baseline gap-2">
			<span class="label">{m.configuration_save_bar_draft()}</span>
			<span class="text-sm font-medium" role="status">{status}</span>
		</p>
		{#if dirtySections.length}
			<p class="key">{dirtySections.join(' · ')}</p>
		{/if}
		{#if blockedReason}
			<p class="text-sm text-ink-2" data-testid="save-blocked-reason">{blockedReason}</p>
		{/if}
		{#if errorMessage}
			<p class="text-sm text-state-error" role="alert">{errorMessage}</p>
		{/if}
		{#if refreshErrorMessage}
			<p class="text-sm text-state-error" role="alert">{refreshErrorMessage}</p>
		{/if}
	</div>
	{#if dirtySections.length}
		<div class="flex gap-2">
			<Button
				type="button"
				variant="outline"
				class="min-h-tap md:min-h-(--control-h)"
				onclick={onDiscard}
				disabled={saving}
			>
				{m.configuration_discard()}
			</Button>
			<Button
				type="button"
				class="min-h-tap md:min-h-(--control-h)"
				onclick={onSave}
				data-save-all
				disabled={saving || previewing || !canSave}
			>
				{saving ? m.configuration_saving() : m.configuration_save_all()}
			</Button>
		</div>
	{:else if refreshErrorMessage}
		<Button
			type="button"
			variant="outline"
			class="min-h-tap md:min-h-(--control-h)"
			onclick={onRetryRefresh}
			disabled={saving}
		>
			{saving ? m.configuration_refreshing() : m.configuration_retry_refresh()}
		</Button>
	{:else if errorMessage}
		<Button
			type="button"
			variant="outline"
			class="min-h-tap md:min-h-(--control-h)"
			onclick={onDismissError}>{m.configuration_dismiss()}</Button
		>
	{/if}
</div>
