<!--
	Configuration editor
	One page in three parts: the Worksite card (name and Committee coverage goal), one
	ordered Attributes column, and the Worksite danger zone at the foot. Above the tablet
	breakpoint the column is capped to the viewport and scrolls inside itself under its
	pinned head; below it the column grows with the page. One foot clip tracks changes
	across all of them.
-->
<script lang="ts">
	import { getContext, tick, untrack } from 'svelte';
	import { reducedMotion as motionIsReduced } from '#lib/shell/motion.svelte.ts';
	import { fly } from 'svelte/transition';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Field from '#lib/components/ui/field/index.ts';
	import {
		configurationDraftContextKey,
		ConfigurationDraftState,
		type ConfigurationDraftContext
	} from './configuration-draft-state.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { Agitation, Language, Worker, Worksite } from '#lib/domain-vocabulary.ts';
	import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
	import AgitationsEditor from './agitations-editor.svelte';
	import AddAttributeForm from './add-attribute-form.svelte';
	import AttributesEditor from './attributes-editor.svelte';
	import ConfigurationPreviewDialog from './configuration-preview-dialog.svelte';
	import ConfigurationSaveBar from './configuration-save-bar.svelte';
	import LanguagesEditor from './languages-editor.svelte';
	import SectionCard from '#lib/shared/section-card.svelte';
	import WorksiteCard from './worksite-card.svelte';
	import WorksiteDangerZone from './worksite-danger-zone.svelte';

	let {
		attributes,
		agitations,
		languages,
		worksite,
		worksiteCount,
		workerCount,
		workers
	}: {
		attributes: WorkerAttributeDefinition[];
		agitations: Agitation[];
		languages: Language[];
		worksite: Worksite;
		worksiteCount: number;
		workerCount: number;
		/** The Worksite's Workers, loaded by the page for the outline's counts. */
		workers: Worker[];
	} = $props();

	const configurationDraft = getContext<ConfigurationDraftContext>(configurationDraftContextKey);
	const draftState = new ConfigurationDraftState(
		untrack(() => ({
			attributes,
			agitations,
			languages,
			worksite,
			configurationDraft
		}))
	);
	const attributeColumnTitle = m.configuration_worker_column_title();
	const headingId = 'worker-column-heading';
	const descriptionId = 'worker-column-description';

	/**
	 * Publishes the pinned title row's height as a CSS variable on the card, so the
	 * column labels pin directly beneath it.
	 */
	function pinHeights(card: HTMLElement) {
		const head = card.querySelector<HTMLElement>('[data-outline-head]');
		if (!head) return;
		const publish = () => card.style.setProperty('--outline-head', `${head.offsetHeight}px`);
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(head);
		return () => observer.disconnect();
	}

	const reducedMotion = $derived(motionIsReduced());
	const saveBarMotion = $derived({ y: 8, duration: reducedMotion ? 0 : 150 });

	/**
	 * The overlaid save bar's measured height. Its content wraps and its dirty-section
	 * list grows, so the pad reserves room for the bar it actually has rather than a
	 * fixed guess that a long list at phone width can outgrow.
	 */
	let saveBarHeight = $state(0);
	const footReserve = $derived(`max(6rem, calc(${saveBarHeight}px + 2rem))`);

	/** Publishes the bar's height to the pad that holds it. */
	function measureSaveBar(node: HTMLElement) {
		const publish = () => (saveBarHeight = node.offsetHeight);
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(node);
		return () => {
			observer.disconnect();
			saveBarHeight = 0;
		};
	}

	/** Tracks the bar's settled states, so focus can be returned once it is done moving. */
	let saveBarWasVisible = false;
	let saveWasRunning = false;

	/**
	 * Hands focus back after the save bar settles: to Save all while it is still enabled
	 * (a failed save), or to the main region once the bar has gone (saved or discarded).
	 * A focus that sits in a field the organizer chose is left alone.
	 */
	function returnFocusAfterSaveBar() {
		void tick().then(() => {
			if (document.activeElement && document.activeElement !== document.body) return;
			const saveButton = document.querySelector<HTMLButtonElement>(
				'button[data-save-all]:not(:disabled)'
			);
			if (saveButton) saveButton.focus();
			else document.getElementById('main-content')?.focus({ preventScroll: true });
		});
	}

	$effect(() => {
		const visible = draftState.showSaveBar;
		const saving = draftState.saving;
		const settled = (saveBarWasVisible && !visible) || (saveWasRunning && !saving);
		saveBarWasVisible = visible;
		saveWasRunning = saving;
		if (settled) returnFocusAfterSaveBar();
	});

	/** The Add attribute control, which returns when the add form closes. */
	let addAttributeButton = $state<HTMLButtonElement | null>(null);

	function cancelAddForm() {
		draftState.addFormOpen = false;
		void tick().then(() => addAttributeButton?.focus());
	}

	/** Deletes the pending Attribute, then lands on the row that took the removed row's place. */
	function confirmDeleteAttribute() {
		const id = draftState.pendingDeleteId;
		if (!id) return;
		const index = draftState.draftAttributes.findIndex((attribute) => attribute.id === id);
		draftState.deleteAttribute(id);
		void tick().then(() => {
			const rows = document.querySelectorAll<HTMLElement>('[data-testid="attribute-row"]');
			if (rows.length === 0) {
				addAttributeButton?.focus();
				return;
			}
			rows[Math.min(index, rows.length - 1)]?.focus();
		});
	}
</script>

<div class="flex flex-1 flex-col gap-6" data-worker-population={workers.length}>
	<!-- Foot room for the overlaid save bar, measured from the bar itself so the sections never move and the bar never covers them. -->
	<div class="grid gap-6" style:padding-bottom={footReserve}>
		<WorksiteCard
			bind:name={draftState.worksiteName}
			savedName={draftState.savedWorksiteName}
			bind:editing={draftState.editingName}
			saving={draftState.saving}
			dirty={draftState.dirtyName}
			bind:committeeGoal={draftState.draftCommitteeGoal}
			committeeGoalError={draftState.committeeGoalError}
		/>

		<SectionCard
			data-testid="worker-column"
			aria-labelledby={headingId}
			aria-describedby={descriptionId}
			class="@container content-start overscroll-none pt-0 md:h-[max(24rem,calc(100dvh-24.5rem))] md:overflow-y-auto"
			{@attach pinHeights}
		>
			<!-- The one pinned title row: the list's name and its add control. -->
			<div
				data-outline-head
				class="sticky top-0 z-10 -mx-6 flex items-center justify-between gap-3 bg-panel px-6 pt-6 pb-2"
			>
				<h2 id={headingId} class="section-title">{attributeColumnTitle}</h2>
				{#if !draftState.addFormOpen}
					<Button
						bind:ref={addAttributeButton}
						type="button"
						variant="outline"
						size="sm"
						class="shrink-0 coarse:min-h-tap"
						data-testid="add-attribute"
						aria-label={m.configuration_add_attribute_to({ column: attributeColumnTitle })}
						disabled={draftState.saving}
						onclick={() => draftState.openAddForm()}
					>
						<PlusIcon data-icon="inline-start" />
						{m.configuration_add_attribute()}
					</Button>
				{/if}
			</div>
			<Field.Description id={descriptionId}
				>{m.configuration_worker_column_description()}</Field.Description
			>
			<h3 class="sr-only">{m.configuration_attributes_title()}</h3>

			{#if draftState.addFormOpen}
				<AddAttributeForm
					bind:name={draftState.addAttributeName}
					bind:type={draftState.addAttributeType}
					nameError={draftState.addAttributeNameError}
					onNameInput={() => (draftState.addAttempted = true)}
					onCancel={cancelAddForm}
					onSubmit={(event) => draftState.submitAddAttribute(event)}
				/>
			{/if}

			<AttributesEditor
				attributes={draftState.draftAttributes}
				allAttributes={draftState.draftAttributes}
				treeLabel={attributeColumnTitle}
				expandedIds={draftState.expandedIds}
				saving={draftState.saving}
				{workers}
				onToggleExpanded={(id) => draftState.toggleExpanded(id)}
				onRequestDelete={(id) => draftState.requestDeleteAttribute(id)}
				onMoveAttribute={(id, direction) => draftState.moveAttribute(id, direction)}
				onAddOption={(attribute, parentId) => draftState.addAttributeOption(attribute, parentId)}
				onRemoveOption={(attributeId, optionId, removeBranch) =>
					draftState.removeAttributeOption(attributeId, optionId, removeBranch)}
				onRenameOption={(attributeId, optionId, text) =>
					draftState.renameAttributeAnswer(attributeId, optionId, text)}
				abbreviationShown={(answer) => draftState.abbreviationShown(answer)}
				onEditAbbreviation={(attributeId, answerId, text) =>
					draftState.editAbbreviation(attributeId, answerId, text)}
				onMergeOption={(attributeId, foldedId, survivorId) =>
					draftState.mergeAttributeAnswer(attributeId, foldedId, survivorId)}
				onMoveAnswer={(attributeId, optionId, parentId) =>
					draftState.moveAttributeAnswer(attributeId, optionId, parentId)}
				onMoveAnswerToAttribute={(source, target) =>
					draftState.moveAnswerToAttribute(source, target)}
				onPromoteAnswer={(source) => draftState.promoteAnswerToAttribute(source)}
				onMoveAnswerSibling={(attributeId, answerId, direction) =>
					draftState.moveAnswerSibling(attributeId, answerId, direction)}
				onMoveAnswerBeside={(attributeId, answerId, targetId, after) =>
					draftState.moveAnswerBeside(attributeId, answerId, targetId, after)}
				answerSiblingPlace={(attributeId, answerId) =>
					draftState.answerSiblingPlace(attributeId, answerId)}
				answerOrder={(attributeId) => draftState.answerOrder(attributeId)}
				onRestoreAnswerOrder={(attributeId, order) =>
					draftState.restoreAnswerOrder(attributeId, order)}
			/>
		</SectionCard>

		<div class="grid gap-6 md:grid-cols-2">
			<SectionCard
				data-testid="agitations-card"
				class="content-start overscroll-none pt-0 md:max-h-[max(20rem,45dvh)] md:overflow-y-auto"
			>
				<AgitationsEditor
					agitations={draftState.visibleAgitations}
					allAgitations={draftState.draftAgitations}
					{workers}
					bind:newAgitationText={draftState.newAgitationText}
					error={draftState.agitationError}
					saving={draftState.saving}
					onInput={() => (draftState.agitationError = '')}
					onSubmit={(event) => draftState.submitAgitation(event)}
					onRemove={(id) => draftState.removeAgitation(id)}
					onRename={(id, text) => draftState.renameAgitation(id, text)}
					onMerge={(foldedId, survivorId) => draftState.mergeAgitation(foldedId, survivorId)}
				/>
			</SectionCard>
			<SectionCard
				data-testid="languages-card"
				class="content-start overscroll-none pt-0 md:max-h-[max(20rem,45dvh)] md:overflow-y-auto"
			>
				<LanguagesEditor
					languages={draftState.visibleLanguages}
					allLanguages={draftState.draftLanguages}
					{workers}
					bind:newLanguageName={draftState.newLanguageName}
					error={draftState.languageError}
					saving={draftState.saving}
					onInput={() => (draftState.languageError = '')}
					onSubmit={(event) => draftState.submitLanguage(event)}
					onRemove={(id) => draftState.removeLanguage(id)}
					onRename={(id, name) => draftState.renameLanguage(id, name)}
					onMerge={(foldedId, survivorId) => draftState.mergeLanguage(foldedId, survivorId)}
				/>
			</SectionCard>
		</div>

		<WorksiteDangerZone {worksite} {worksiteCount} {workerCount} />
	</div>

	<!-- Zero-height anchor at the foot (-mt-6 cancels its flex gap): the bar overlays the pad's end instead of resizing the scroll region, and the anchor sticks to the viewport foot so the bar stays in view while you edit above it. -->
	<div class="sticky bottom-0 z-10 -mt-6 h-0">
		{#if draftState.showSaveBar}
			<div
				class="absolute inset-x-0 bottom-0"
				transition:fly={saveBarMotion}
				{@attach measureSaveBar}
			>
				<ConfigurationSaveBar
					saving={draftState.saving}
					previewing={draftState.previewing}
					refreshingData={draftState.refreshingData}
					dirtySections={draftState.dirtySections}
					canSave={draftState.canSave}
					blockedReason={draftState.canSave ? '' : draftState.attributeSaveBlockReason}
					errorMessage={draftState.errorMessage}
					refreshErrorMessage={draftState.refreshErrorMessage}
					onDiscard={() => draftState.discardAll()}
					onSave={() => draftState.saveAll()}
					onRetryRefresh={() => draftState.retryRefresh()}
					onDismissError={() => (draftState.errorMessage = '')}
				/>
			</div>
		{/if}
	</div>

	<!-- The bar unmounts the moment nothing is dirty, so save completion and the blocked
	     reason announce from a status region that outlives it. -->
	<p class="sr-only" role="status" aria-live="polite" data-testid="configuration-save-announcement">
		{draftState.saveAnnouncement || (draftState.canSave ? '' : draftState.attributeSaveBlockReason)}
	</p>
</div>

<AlertDialog.Root
	open={draftState.deleteDialogOpen}
	onOpenChange={(open) => {
		draftState.deleteDialogOpen = open;
		if (!open) draftState.pendingDeleteId = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{m.configuration_delete_title({
					name:
						draftState.pendingDeleteAttribute?.name || m.configuration_delete_attribute_fallback()
				})}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{m.configuration_delete_attribute_description()}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				class="bg-destructive text-on-action hover:bg-destructive/90"
				onclick={confirmDeleteAttribute}
			>
				{m.configuration_delete_attribute_action()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<ConfigurationPreviewDialog
	open={draftState.previewOpen}
	rows={draftState.previewRows}
	summary={draftState.previewSummary}
	requiresConfirmation={draftState.previewRequiresConfirmation}
	sharedLoss={draftState.previewSharedLoss}
	resolutionGroups={draftState.previewResolutionGroups}
	resolutionsComplete={draftState.previewResolutionsComplete}
	onChoose={(key, choice) => draftState.chooseResolution(key, choice)}
	onConfirm={() => draftState.confirmPreview()}
	onCancel={() => draftState.cancelPreview()}
/>
