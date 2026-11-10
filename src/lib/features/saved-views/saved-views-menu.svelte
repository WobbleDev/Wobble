<script lang="ts">
	/**
	 * The Views control of a view host: the Worksite's saved views of this kind, each opened
	 * as an editable copy, with Update for the open one, Save as, Rename and Delete. Nothing
	 * is stored until one of those is chosen.
	 */
	import CheckIcon from '@lucide/svelte/icons/check';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import type { SavedViews, SavedViewsFailure } from './saved-views.svelte.ts';

	type Props = {
		views: SavedViews;
		class?: string;
		/** The element the popover keeps inside, where the host has one. */
		boundary?: HTMLElement;
		/** The map's glass chrome. */
		glass?: boolean;
	};
	let { views, class: className, boundary, glass = false }: Props = $props();

	let open = $state(false);
	let newName = $state('');
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let deletingId = $state<string | null>(null);

	const failureCopy: Record<SavedViewsFailure, () => string> = {
		load: () => m.views_failure_load(),
		save: () => m.views_failure_save(),
		nameTaken: () => m.views_failure_name_taken(),
		invalidName: () => m.views_failure_invalid_name(),
		gone: () => m.views_failure_gone()
	};

	function onOpenChange(next: boolean) {
		open = next;
		renamingId = null;
		deletingId = null;
		if (next) void views.load();
	}

	async function saveAs(event: SubmitEvent) {
		event.preventDefault();
		if (await views.saveAs(newName)) newName = '';
	}

	async function rename(event: SubmitEvent, id: string) {
		event.preventDefault();
		if (await views.rename(id, renameValue)) renamingId = null;
	}

	async function remove(id: string) {
		if (await views.remove(id)) deletingId = null;
	}
</script>

<Popover.Root {open} {onOpenChange}>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				size="sm"
				data-testid="views-trigger"
				data-material={glass ? 'glass' : undefined}
				class={className ?? 'min-h-tap shrink-0 lg:h-8 lg:min-h-8'}
			>
				{m.views_menu()}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		align="end"
		collisionBoundary={boundary}
		class="max-h-[min(32rem,70vh)] w-80 max-w-full gap-3 overflow-y-auto rounded-surface bg-panel p-3 shadow-[var(--surface-shadow)]"
		data-testid="views-panel"
	>
		<ul class="flex flex-col gap-1" aria-label={m.views_menu()}>
			{#each views.views as view (view.id)}
				<li data-testid="view-row" data-view-name={view.name}>
					{#if renamingId === view.id}
						<form class="flex items-center gap-1" onsubmit={(event) => rename(event, view.id)}>
							<Input
								aria-label={m.views_rename_named({ name: view.name })}
								bind:value={renameValue}
								class="min-h-tap min-w-0 flex-1 lg:h-8 lg:min-h-8"
							/>
							<Button type="submit" size="sm" disabled={views.busy}>{m.views_save()}</Button>
							<Button type="button" variant="ghost" size="sm" onclick={() => (renamingId = null)}>
								{m.views_cancel()}
							</Button>
						</form>
					{:else if deletingId === view.id}
						<div class="flex items-center gap-1">
							<span class="min-w-0 flex-1 truncate text-sm">
								{m.views_delete_confirm({ name: view.name })}
							</span>
							<Button
								variant="destructive"
								size="sm"
								class="bg-destructive text-on-action hover:bg-destructive/90"
								disabled={views.busy}
								onclick={() => remove(view.id)}
							>
								{m.views_delete()}
							</Button>
							<Button variant="ghost" size="sm" onclick={() => (deletingId = null)}>
								{m.views_cancel()}
							</Button>
						</div>
					{:else}
						<div class="flex items-center gap-1">
							<Button
								variant="ghost"
								size="sm"
								class="min-h-tap min-w-0 flex-1 justify-start lg:min-h-8"
								aria-label={m.views_open_named({ name: view.name })}
								aria-current={views.opened?.id === view.id ? 'true' : undefined}
								onclick={() => {
									views.open(view);
									open = false;
								}}
							>
								<span class="truncate">{view.name}</span>
								{#if views.opened?.id === view.id}
									<CheckIcon class="ml-auto size-4 shrink-0" />
								{/if}
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={m.views_rename_named({ name: view.name })}
								onclick={() => {
									renamingId = view.id;
									renameValue = view.name;
									deletingId = null;
								}}
							>
								<PencilIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={m.views_delete_named({ name: view.name })}
								onclick={() => {
									deletingId = view.id;
									renamingId = null;
								}}
							>
								<Trash2Icon />
							</Button>
						</div>
					{/if}
				</li>
			{:else}
				{#if views.loaded}
					<li class="px-2 py-1 text-sm text-muted-foreground">{m.views_none()}</li>
				{/if}
			{/each}
		</ul>

		{#if views.opened}
			<Button
				variant="outline"
				size="sm"
				data-testid="view-update"
				disabled={views.busy || !views.openedChanged}
				onclick={() => void views.update()}
			>
				{m.views_update({ name: views.opened.name })}
			</Button>
		{/if}

		<form class="flex items-center gap-1" onsubmit={saveAs}>
			<Input
				aria-label={m.views_name_label()}
				placeholder={m.views_name_label()}
				bind:value={newName}
				data-testid="view-name"
				class="min-h-tap min-w-0 flex-1 lg:h-8 lg:min-h-8"
			/>
			<Button
				type="submit"
				size="sm"
				data-testid="view-save-as"
				disabled={views.busy || newName.trim() === ''}
			>
				{m.views_save_as()}
			</Button>
		</form>

		{#if views.failure}
			<p class="text-sm text-destructive" role="alert" data-testid="views-failure">
				{failureCopy[views.failure]()}
			</p>
		{/if}
	</Popover.Content>
</Popover.Root>
