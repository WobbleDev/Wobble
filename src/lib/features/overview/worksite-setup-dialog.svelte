<script lang="ts">
	/**
	 * The dialog Overview shows when a Worksite has nothing in it yet: the first steps,
	 * including a contact import.
	 */
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { tick, untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Dialog from '#lib/components/ui/dialog/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { saveWorksiteName } from '#lib/client/workers-api.ts';
	import type { Worksite } from '#lib/domain-vocabulary.ts';
	import { replaceCurrentUrl } from '#lib/shared/navigation.ts';
	import ContactCsvImportDialog from '../workers/contact-import/contact-csv-import-dialog.svelte';

	let { worksite }: { worksite: Worksite } = $props();

	let setupOpen = $state(true);
	let importerOpen = $state(false);
	let openingImporter = $state(false);
	let worksiteName = $state(untrack(() => worksite.name));
	let saving = $state(false);
	let errorMessage = $state('');

	function dismissSetup() {
		replaceCurrentUrl((params) => params.delete('setup'), page.state);
	}

	async function saveName() {
		const name = worksiteName.trim();
		if (name) {
			await saveWorksiteName(name);
			await invalidateAll();
		}
	}

	async function finishSetup() {
		saving = true;
		errorMessage = '';
		try {
			await saveName();
			// Closing the dialog is what takes its portal and overlay out of the DOM, the
			// way Skip does. `dismissSetup()` cannot do it alone: `replaceState` rewrites
			// the address but leaves `page.url` untouched, so the page's `{#if}` never
			// sees `?setup=1` go away and never unmounts this component.
			setupOpen = false;
			dismissSetup();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : m.onboarding_save_name_failed();
		} finally {
			saving = false;
		}
	}

	function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		void finishSetup();
	}

	async function startImport() {
		saving = true;
		errorMessage = '';
		try {
			await saveName();
			openingImporter = true;
			setupOpen = false;
			await tick();
			importerOpen = true;
			openingImporter = false;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : m.onboarding_save_name_failed();
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root
	bind:open={setupOpen}
	onOpenChange={(open) => {
		if (!open && !openingImporter) dismissSetup();
	}}
>
	<!-- Skip is the dismissal here, so the corner close button would be a second one. -->
	<Dialog.Content class="sm:max-w-lg" showCloseButton={false}>
		<form class="grid gap-6" onsubmit={onSubmit}>
			<Dialog.Header>
				<Dialog.Title>{m.onboarding_setup_title()}</Dialog.Title>
				<Dialog.Description>{m.onboarding_setup_description()}</Dialog.Description>
			</Dialog.Header>

			<Field.FieldGroup>
				<Field.Field>
					<Field.FieldLabel for="setup-worksite-name" class="field-label"
						>{m.onboarding_worksite_name()}</Field.FieldLabel
					>
					<Input
						id="setup-worksite-name"
						bind:value={worksiteName}
						class="min-h-tap lg:min-h-(--control-h)"
						onfocus={(event) => event.currentTarget.select()}
					/>
				</Field.Field>
			</Field.FieldGroup>

			{#if errorMessage}
				<p class="text-sm text-state-error" role="alert">{errorMessage}</p>
			{/if}

			<Dialog.Footer>
				<Dialog.Close disabled={saving}>{m.onboarding_skip_setup()}</Dialog.Close>
				<Button
					type="button"
					variant="outline"
					class="min-h-tap md:min-h-(--control-h)"
					onclick={startImport}
					disabled={saving}
				>
					{m.onboarding_import_contacts()}
				</Button>
				<Button type="submit" class="min-h-tap md:min-h-(--control-h)" disabled={saving}>
					{saving ? m.onboarding_saving() : m.onboarding_finish_setup()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

{#if importerOpen}
	<ContactCsvImportDialog bind:open={importerOpen} onClose={dismissSetup} />
{/if}
