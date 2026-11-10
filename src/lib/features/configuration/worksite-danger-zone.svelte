<!--
	Worksite danger zone
	The only destructive Worksite action, separated from the routine editing sections and guarded by
	a confirmation that names the Active Worksite, its Worker count, and the full cascade.

	It is a recess like its sibling sections, not a box drawn round a box: the
	destructive heading carries the error role and the control sits at the foot,
	so the section reads as one more step in the ladder that happens to be
	dangerous, rather than as a warning pasted over it.
-->
<script lang="ts">
	import SectionCard from '#lib/shared/section-card.svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { getContext } from 'svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import { deleteWorksite } from '#lib/client/workers-api.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { Worksite } from '#lib/domain-vocabulary.ts';
	import {
		configurationDraftContextKey,
		type ConfigurationDraftContext
	} from './configuration-draft-state.svelte.ts';

	let {
		worksite,
		worksiteCount,
		workerCount
	}: { worksite: Worksite; worksiteCount: number; workerCount: number } = $props();

	const configurationDraft = getContext<ConfigurationDraftContext>(configurationDraftContextKey);

	let confirmOpen = $state(false);
	let pending = $state(false);
	let errorMessage = $state('');

	const deleteButtonLabel = $derived(m.configuration_delete_worksite());
	const hasUnsavedDraft = $derived(configurationDraft.hasUnsavedChanges);
	const isOnlyWorksite = $derived(worksiteCount === 1);
	const cascadeSummary = $derived(m.configuration_delete_cascade({ count: workerCount }));
	const sectionDescription = $derived(
		m.configuration_delete_section_description({ name: worksite.name, cascade: cascadeSummary })
	);
	const confirmationDescription = $derived(
		m.configuration_delete_confirmation_description({
			name: worksite.name,
			cascade: cascadeSummary
		})
	);

	function openConfirmation() {
		errorMessage = '';
		confirmOpen = true;
	}

	async function confirmDelete() {
		if (pending) return;

		pending = true;
		errorMessage = '';
		try {
			await deleteWorksite();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : m.configuration_delete_failed();
			pending = false;
			return;
		}

		pending = false;
		confirmOpen = false;
		// Navigate only after a successful delete and outside the delete error path, so a failed
		// navigation can never be reported as a failed deletion.
		await goto(resolve('/overview'), { invalidateAll: true });
	}
</script>

<SectionCard
	aria-labelledby="worksite-danger-zone-heading"
	aria-describedby="worksite-danger-zone-description"
>
	<div class="grid gap-1">
		<!-- The description stays a sentence in the sans voice: it is the text the
		     region and its button are described by, so it is read, not scanned. -->
		<h2 id="worksite-danger-zone-heading" class="section-title text-state-error">
			{m.configuration_danger_zone()}
		</h2>
		<Field.Description id="worksite-danger-zone-description">
			{sectionDescription}
		</Field.Description>
	</div>
	<div>
		<Button
			type="button"
			variant="destructive"
			class="min-h-tap md:min-h-(--control-h)"
			aria-describedby="worksite-danger-zone-description"
			onclick={openConfirmation}
		>
			{deleteButtonLabel}
		</Button>
	</div>
</SectionCard>

<AlertDialog.Root
	bind:open={confirmOpen}
	onOpenChange={(open) => {
		if (pending) {
			confirmOpen = true;
			return;
		}
		confirmOpen = open;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.configuration_delete_title({ name: worksite.name })}</AlertDialog.Title>
			<AlertDialog.Description>
				{confirmationDescription}
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if hasUnsavedDraft}
			<p class="text-sm font-medium text-state-error">
				{m.configuration_delete_unsaved_warning()}
			</p>
		{/if}
		{#if isOnlyWorksite}
			<p class="text-sm font-medium text-state-error">
				{m.configuration_delete_only_worksite()}
			</p>
		{/if}
		{#if errorMessage}
			<p class="text-sm text-state-error" role="alert">{errorMessage}</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={pending}>{m.common_cancel()}</AlertDialog.Cancel>
			<Button
				variant="destructive"
				class="bg-destructive text-on-action hover:bg-destructive/90"
				disabled={pending}
				onclick={confirmDelete}
			>
				{pending ? m.configuration_deleting() : deleteButtonLabel}
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
