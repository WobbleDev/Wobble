<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { changePassphrase } from '#lib/client/boot-api.ts';
	import * as Dialog from '#lib/components/ui/dialog/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';
	import PassphraseInput from '#lib/shared/ui/passphrase-input.svelte';
	import FileReceipt from '../file-receipt.svelte';
	import { createPassphraseChange } from '../passphrase-change.svelte.ts';
	import SettingsRow from '../settings-row.svelte';
	import SettingsWell from '../settings-well.svelte';

	let { encrypted }: { encrypted: boolean } = $props();

	let changeOpen = $state(false);
	let confirmInput = $state<HTMLInputElement | null>(null);
	let doneButton = $state<HTMLElement | null>(null);
	const change = createPassphraseChange({ change: changePassphrase });

	/** Whether the current error is about this field, for its invalid and description wiring. */
	function fieldError(field: 'current' | 'next' | 'confirm'): boolean {
		if (change.error === 'required') {
			const value =
				field === 'current' ? change.current : field === 'next' ? change.next : change.confirm;
			return value === '';
		}
		if (change.error === 'confirm') return field === 'confirm';
		if (change.error === 'wrong') return field === 'current';
		return false;
	}

	$effect(() => {
		if (change.receipt) doneButton?.focus({ preventScroll: true });
	});
</script>

<SettingsWell
	id="privacy"
	title={m.settings_privacy_title()}
	description={m.settings_privacy_description()}
>
	<SettingsRow
		id="prv-encryption"
		title={m.settings_encryption_title()}
		description={encrypted ? m.settings_encryption_on() : m.settings_encryption_unknown()}
	/>

	<SettingsRow id="prv-change" title={m.settings_password()}>
		<Button
			type="button"
			variant="outline"
			disabled={!encrypted}
			onclick={() => {
				change.reset();
				changeOpen = true;
			}}>{m.settings_change_password()}</Button
		>
	</SettingsRow>
</SettingsWell>

<Dialog.Root
	bind:open={changeOpen}
	onOpenChange={(open) => {
		if (!open && change.busy) {
			changeOpen = true;
			return;
		}
		if (!open) change.reset();
	}}
>
	<Dialog.Content
		showCloseButton={!change.busy}
		onEscapeKeydown={(event) => {
			if (change.busy) event.preventDefault();
		}}
		onInteractOutside={(event) => {
			if (change.busy) event.preventDefault();
		}}
	>
		<Dialog.Header
			><Dialog.Title>{m.settings_change_password()}</Dialog.Title>
			<Dialog.Description>{m.boot_forgot()}</Dialog.Description>
		</Dialog.Header>
		{#if change.receipt}
			<p role="status" class="text-sm">{m.settings_passphrase_changed()}</p>
			<p class="text-sm text-ink-2">{m.settings_passphrase_recovery()}</p>
			<FileReceipt path={change.receipt} />
			<Button
				type="button"
				class="min-h-tap md:min-h-9"
				bind:ref={doneButton}
				onclick={() => (changeOpen = false)}>{m.common_done()}</Button
			>
		{:else}
			<form
				class="grid gap-4"
				autocomplete="off"
				onsubmit={async (event) => {
					event.preventDefault();
					await change.submit();
					if (change.error === 'confirm') confirmInput?.focus({ preventScroll: true });
				}}
			>
				<div class="grid gap-2">
					<Label class="field-label" for="passphrase-current"
						>{m.settings_passphrase_current()}</Label
					><PassphraseInput
						id="passphrase-current"
						showLabel={m.passphrase_show()}
						bind:value={change.current}
						disabled={change.busy}
						aria-invalid={fieldError('current')}
						aria-describedby={fieldError('current') ? 'passphrase-error' : undefined}
					/>
				</div>
				<div class="grid gap-2">
					<Label class="field-label" for="passphrase-next">{m.settings_passphrase_new()}</Label
					><PassphraseInput
						id="passphrase-next"
						showLabel={m.passphrase_show()}
						bind:value={change.next}
						disabled={change.busy}
						aria-invalid={fieldError('next')}
						aria-describedby={`passphrase-spaces${fieldError('next') ? ' passphrase-error' : ''}`}
					/>
					<p id="passphrase-spaces" class="text-sm text-ink-2">{m.passphrase_spaces_hint()}</p>
				</div>
				<div class="grid gap-2">
					<Label class="field-label" for="passphrase-confirm"
						>{m.settings_passphrase_confirm()}</Label
					><PassphraseInput
						id="passphrase-confirm"
						showLabel={m.passphrase_show()}
						bind:ref={confirmInput}
						bind:value={change.confirm}
						disabled={change.busy}
						aria-invalid={fieldError('confirm')}
						aria-describedby={fieldError('confirm') ? 'passphrase-error' : undefined}
					/>
				</div>
				{#if change.error}<p id="passphrase-error" role="alert" class="text-sm text-state-error">
						{change.error === 'required'
							? m.boot_error_required()
							: change.error === 'confirm'
								? m.boot_error_confirm()
								: change.error === 'wrong'
									? m.boot_error_wrong()
									: m.settings_passphrase_error()}
					</p>{/if}
				{#if change.recoveryCopy}<p class="text-sm text-ink-2">
						{m.settings_passphrase_recovery()}
					</p>
					<FileReceipt path={change.recoveryCopy} />{/if}
				<Button class="min-h-tap md:min-h-9" type="submit" disabled={change.busy}
					>{change.busy ? m.settings_passphrase_changing() : m.settings_change_password()}</Button
				>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
