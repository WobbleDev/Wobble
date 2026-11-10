<script lang="ts">
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { getContext } from 'svelte';
	import { storeActiveWorksiteId } from '#lib/client/active-worksite-storage.ts';
	import { dataErrorCopy, eraseAllData, type DataErrorCopy } from '#lib/client/data-api.ts';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { appSettingsContextKey, type AppSettingsContext } from '#lib/shared/app-settings.ts';
	import { m } from '#lib/paraglide/messages.js';
	import DataErrorNotice from '../data-error-notice.svelte';
	import FileReceipt from '../file-receipt.svelte';
	import { reloadPage } from '../reload-page.ts';
	import SettingsRow from '../settings-row.svelte';
	import SettingsWell from '../settings-well.svelte';

	const settings = getContext<AppSettingsContext>(appSettingsContextKey);

	let resetOpen = $state(false);
	let eraseOpen = $state(false);
	let eraseConfirmation = $state('');
	/* The core requires exactly 'erase', so the UI arms on nothing looser. */
	const eraseArmed = $derived(eraseConfirmation === 'erase');

	let erasing = $state(false);
	let eraseError = $state<DataErrorCopy | null>(null);
	let eraseSafetyCopy = $state('');

	/* Erase is live in the browser too: it needs no file picker. The core keeps the schema
	   and the settings, and the browser forgets the Active Worksite along with the data. */
	async function eraseEverything(): Promise<void> {
		erasing = true;
		eraseError = null;
		try {
			eraseSafetyCopy = await eraseAllData();
			storeActiveWorksiteId(null);
		} catch (error) {
			eraseError = dataErrorCopy(error, m.settings_data_error_erase());
		} finally {
			erasing = false;
		}
	}
</script>

<SettingsWell
	id="reset"
	title={m.settings_reset_title()}
	description={m.settings_reset_description()}
>
	<SettingsRow
		id="rst-settings"
		title={m.settings_reset_settings_title()}
		description={m.settings_reset_settings_description()}
	>
		<Button
			type="button"
			variant="outline"
			class="min-h-tap md:min-h-9"
			onclick={() => (resetOpen = true)}
		>
			<RotateCcw aria-hidden="true" class="size-4" />
			{m.settings_reset_settings_button()}
		</Button>
	</SettingsRow>
	<SettingsRow
		id="rst-erase"
		title={m.settings_erase_title()}
		description={m.settings_erase_description()}
	>
		<Button
			type="button"
			variant="destructive"
			class="min-h-tap md:min-h-9"
			onclick={() => (eraseOpen = true)}
		>
			<Trash2 aria-hidden="true" class="size-4" />
			{m.settings_erase_button()}
		</Button>
	</SettingsRow>
</SettingsWell>

<AlertDialog.Root bind:open={resetOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.settings_reset_dialog_title()}</AlertDialog.Title>
			<AlertDialog.Description>{m.settings_reset_dialog_description()}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action disabled={settings.saving} onclick={() => void settings.reset()}>
				{m.settings_reset_dialog_action()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<!-- Erase: the one irreversible action here, so it makes the person say so. -->
<AlertDialog.Root
	bind:open={eraseOpen}
	onOpenChange={(open) => {
		if (!open) {
			eraseConfirmation = '';
			eraseError = null;
			eraseSafetyCopy = '';
		}
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.settings_erase_dialog_title()}</AlertDialog.Title>
			<AlertDialog.Description>{m.settings_erase_dialog_description()}</AlertDialog.Description>
		</AlertDialog.Header>
		{#if eraseSafetyCopy}
			<div class="grid gap-2">
				<p class="text-sm text-ink-2" role="status">{m.settings_erase_safety_copy()}</p>
				<FileReceipt path={eraseSafetyCopy} />
				<Button type="button" class="min-h-tap md:min-h-9" onclick={reloadPage}
					>{m.settings_reload()}</Button
				>
			</div>
		{:else}
			<div class="grid gap-2">
				<Field.FieldLabel for="erase-confirmation" class="field-label">
					{m.settings_erase_confirm_label({ token: 'erase' })}
				</Field.FieldLabel>
				<Input
					id="erase-confirmation"
					bind:value={eraseConfirmation}
					autocomplete="off"
					spellcheck={false}
				/>
			</div>
			{#if eraseError}
				<DataErrorNotice error={eraseError} />
			{/if}
			<AlertDialog.Footer>
				<AlertDialog.Cancel>{m.common_cancel()}</AlertDialog.Cancel>
				<Button
					type="button"
					variant="destructive"
					class="min-h-tap md:min-h-9"
					disabled={!eraseArmed || erasing}
					onclick={() => void eraseEverything()}
				>
					<TriangleAlert aria-hidden="true" class="size-4" />
					{erasing ? m.settings_erasing() : m.settings_erase_everything()}
				</Button>
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
