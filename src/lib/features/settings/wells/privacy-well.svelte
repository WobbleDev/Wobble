<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { changePassphrase } from '#lib/client/boot-api.ts';
	import * as Dialog from '#lib/components/ui/dialog/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';
	import FileReceipt from '../file-receipt.svelte';
	import { createPassphraseChange } from '../passphrase-change.svelte.ts';
	import SettingsRow from '../settings-row.svelte';
	import SettingsWell from '../settings-well.svelte';

	let { encrypted }: { encrypted: boolean } = $props();

	let changeOpen = $state(false);
	const change = createPassphraseChange({ change: changePassphrase });
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
		{:else}
			<form
				class="grid gap-4"
				autocomplete="off"
				onsubmit={(event) => {
					event.preventDefault();
					void change.submit();
				}}
			>
				<div class="grid gap-2">
					<Label class="field-label" for="passphrase-current"
						>{m.settings_passphrase_current()}</Label
					><Input
						id="passphrase-current"
						type="password"
						bind:value={change.current}
						autocomplete="off"
						disabled={change.busy}
					/>
				</div>
				<div class="grid gap-2">
					<Label class="field-label" for="passphrase-next">{m.settings_passphrase_new()}</Label
					><Input
						id="passphrase-next"
						type="password"
						bind:value={change.next}
						autocomplete="off"
						disabled={change.busy}
					/>
				</div>
				<div class="grid gap-2">
					<Label class="field-label" for="passphrase-confirm"
						>{m.settings_passphrase_confirm()}</Label
					><Input
						id="passphrase-confirm"
						type="password"
						bind:value={change.confirm}
						autocomplete="off"
						disabled={change.busy}
					/>
				</div>
				{#if change.error}<p role="alert" class="text-sm text-state-error">
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
