<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import SwatchDot from '#lib/shared/swatch-dot.svelte';
	import { cn } from '#lib/utils.ts';
	import { createDataTableActionState } from './data-table-action-state.svelte.ts';
	import type { DataTableEditReport } from './data-table-features.ts';
	import { runSingleEdit } from './data-table-bulk-actions.ts';
	import type { OptionChoice } from '../answers.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { formatList } from '#lib/i18n/format.ts';

	type BaseProps = {
		workerName: string;
		label: string;
		/** The lower-case action name: "assessment", "languages", or an Attribute's own label. */
		actionLabel?: string;
		/** What the menu offers: `value` is what a choice saves, `label` what it shows. */
		options: readonly OptionChoice[];
		/** Colour for the selected value's leading dot (Assessment). */
		swatch?: string;
		/** Colour per option, used for the dots inside the menu. */
		swatchFor?: (value: string) => string;
		/** The no-value reading for this Attribute's cell; an em dash when not given. */
		emptyLabel?: string;
		/** The reading's secondary description, when a real answer reads the same. */
		emptyDescription?: string;
		/** Called once the write landed, with its reload and Undo outcome. */
		onSaved?: (report: DataTableEditReport) => void;
		/** Called with a plain-words message when the write did not save. */
		onFailed?: (message: string) => void;
		/** Reloads the Workers table; kept apart from `onUpdate` so a reload failure is not a write failure. */
		refresh: () => Promise<void>;
		fallbackMessage?: string;
	};

	type SingleProps = BaseProps & {
		type: 'single';
		selected: string | '';
		allowNone?: boolean;
		showBadge?: boolean;
		invalidMessage?: string;
		/**
		 * Saves the choice. It may answer its own way back (an edit that restores a
		 * stored snapshot); without one, Undo re-saves the previous value.
		 */
		onUpdate: (value: string) => Promise<void | (() => Promise<void>)>;
	};

	type MultiProps = BaseProps & {
		type: 'multi';
		selected: readonly string[];
		onUpdate: (values: string[]) => Promise<void>;
	};

	let props: SingleProps | MultiProps = $props();

	const updateState = createDataTableActionState();
	let triggerNode = $state<HTMLElement | null>(null);
	let armed = $state(false);
	// The menu opens with the cell's first use and closes once its save lands: a
	// multi menu stays open across toggles (closeOnSelect is off), but an open
	// menu holds the body's pointer events, so one left open after the write
	// reads as the whole app freezing in place.
	let menuOpen = $state(false);
	function arm() {
		armed = true;
		menuOpen = true;
	}

	const actionLabel = $derived(props.actionLabel ?? props.label);
	// The generic field copy, because this cell now serves every Attribute.
	const fallbackMessage = $derived(
		props.fallbackMessage ?? m.workers_field_save_fallback({ field: actionLabel })
	);

	const invalidMessage = $derived(
		props.type === 'single'
			? (props.invalidMessage ?? m.workers_field_save_fallback({ field: actionLabel }))
			: ''
	);

	const savedMessage = $derived(
		m.workers_field_saved({ worker: props.workerName, field: props.label })
	);

	/** The text a value shows as; blank when the menu does not offer it. */
	function labelOf(value: string): string {
		return props.options.find((candidate) => candidate.value === value)?.label ?? '';
	}

	async function commit(apply: () => Promise<void>, revert: () => Promise<void>, summary: string) {
		if (updateState.pending) return;

		let report: DataTableEditReport | null = null;
		const saved = await updateState.run(async () => {
			const result = await runSingleEdit({
				apply,
				restore: revert,
				refresh: props.refresh,
				summary,
				fallback: fallbackMessage
			});
			// Only a write failure is the cell's own error; a failed reload is reported.
			if (result.error) throw new Error(result.error);
			report = result;
		}, fallbackMessage);
		if (saved && report) {
			props.onSaved?.(report);
			// The write landed: hand the page back. A failed write keeps the menu
			// open so the choice can be tried again.
			menuOpen = false;
		}
		// The cell keeps its previous value; the status line says why.
		else if (!saved) props.onFailed?.(fallbackMessage);
	}

	async function updateSingle(value: string) {
		if (props.type !== 'single' || updateState.pending) return;

		const option =
			value === '' ? '' : props.options.find((candidate) => candidate.value === value)?.value;
		if (option === undefined) {
			props.onFailed?.(invalidMessage);
			return;
		}

		// Snapshot the write: Undo must reach the Worker this edit started on (ticket 25).
		const update = props.onUpdate;
		const previous = props.selected;

		let undo: (() => Promise<void>) | undefined;
		await commit(
			async () => {
				const way = await update(option);
				if (typeof way === 'function') undo = way;
			},
			() => (undo ? undo() : update(previous).then(() => undefined)),
			savedMessage
		);
	}

	async function updateMulti(option: string, checked: boolean) {
		if (props.type !== 'multi' || updateState.pending) return;

		const previous = [...props.selected];
		const update = props.onUpdate;
		const values = checked
			? [...props.selected, option]
			: props.selected.filter((value) => value !== option);

		await commit(
			() => update(values),
			() => update(previous),
			savedMessage
		);
	}
</script>

{#snippet swatchDot(value: string)}
	{#if props.swatchFor}
		<SwatchDot color={props.swatchFor(value)} />
	{/if}
{/snippet}

{#snippet emptyValue()}
	<span class="text-ink-3">
		{props.emptyLabel ?? '—'}{#if props.emptyDescription}<span class="ml-1 text-xs"
				>· {props.emptyDescription}</span
			>{/if}
	</span>
{/snippet}

{#snippet triggerButton(extra: Record<string, unknown>)}
	<Button
		{...extra}
		bind:ref={triggerNode}
		variant="ghost"
		class={cn(
			// A minimum, not a height: the row grows when a value wraps, and
			// `h-auto` keeps the control's own body height out of the way.
			'-mx-1 h-auto min-h-tap w-full max-w-full min-w-0 justify-start gap-1.5 rounded-item px-1 text-left font-normal lg:min-h-7',
			updateState.pending && 'opacity-60'
		)}
		aria-label={props.type === 'multi' && props.selected.length > 0
			? m.workers_cell_edit_selected({
					field: actionLabel,
					worker: props.workerName,
					values: formatList(props.selected.map(labelOf))
				})
			: m.workers_cell_edit({ field: actionLabel, worker: props.workerName })}
		aria-busy={updateState.pending}
		disabled={updateState.pending}
	>
		{#if props.type === 'single'}
			{#if props.selected}
				{#if props.swatch}
					<span class="flex min-w-0 items-start gap-1.5">
						<SwatchDot color={props.swatch} class="mt-1.5" />
						<span class="break-words whitespace-normal">{labelOf(props.selected)}</span>
					</span>
				{:else if props.showBadge}
					<span
						class="rounded-item bg-chip px-1.5 py-0.5 break-words whitespace-normal ring-1 ring-inset ring-rule-strong"
					>
						{labelOf(props.selected)}
					</span>
				{:else}
					<span class="break-words whitespace-normal">{labelOf(props.selected)}</span>
				{/if}
			{:else}
				{@render emptyValue()}
			{/if}
		{:else if props.selected.length > 0}
			<span class="flex min-w-0 flex-nowrap items-center gap-1">
				{#each props.selected.slice(0, 2) as value (value)}
					<span
						title={labelOf(value)}
						class="h-5 min-w-0 truncate rounded-item bg-chip px-1.5 text-sm leading-5 whitespace-nowrap ring-1 ring-inset ring-rule-strong"
						>{labelOf(value)}</span
					>
				{/each}
				{#if props.selected.length > 2}
					<span
						class="h-5 shrink-0 rounded-item bg-chip px-1.5 text-sm leading-5 whitespace-nowrap text-ink-3 ring-1 ring-inset ring-rule-strong"
						>+{props.selected.length - 2}</span
					>
				{/if}
			</span>
		{:else}
			{@render emptyValue()}
		{/if}
	</Button>
{/snippet}

{#if !armed}
	<!--
		Until it is first used a cell is only its trigger: a menu root per cell, a dozen
		per row, made scrolling mount rows too slowly. The first click, or the key that
		opens an editor, mounts the real menu already open.
	-->
	{@render triggerButton({
		'aria-haspopup': 'menu',
		'aria-expanded': false,
		onclick: arm,
		onkeydown: (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
				event.preventDefault();
				event.stopPropagation();
				arm();
			}
		}
	})}
{:else}
	<DropdownMenu.Root bind:open={menuOpen}>
		<DropdownMenu.Trigger>
			{#snippet child({ props: triggerProps })}
				{@render triggerButton(triggerProps)}
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content
			align="start"
			onCloseAutoFocus={(event) => {
				// Opened from the grid, the editor hands focus back to its cell, not the
				// control inside it, which is out of the Tab order there.
				const cell = triggerNode?.closest<HTMLElement>('td[data-column-id][tabindex]');
				if (!cell) return;
				event.preventDefault();
				cell.focus();
			}}
		>
			{#if props.options.length === 0}
				<!--
				An unconfigured category opens an empty box otherwise: the trigger is
				still an editor, but the Worksite has not said what the values are.
				The Workers table is not where that list is written, so point at the view
				that owns it rather than leaving the menu blank.
			-->
				<div class="grid gap-0.5 px-2 py-1.5">
					<p class="text-sm text-muted-foreground">{m.workers_filter_nothing_set_up()}</p>
					<p class="text-sm text-muted-foreground">
						{m.workers_filter_add_in_configuration({ label: props.label })}
					</p>
				</div>
			{:else if props.type === 'single'}
				<DropdownMenu.RadioGroup
					value={props.selected}
					onValueChange={(value) => updateSingle(value)}
				>
					{#if props.allowNone}
						<DropdownMenu.RadioItem value="" disabled={updateState.pending}>
							{m.common_none()}
						</DropdownMenu.RadioItem>
					{/if}
					{#each props.options as option (option.value)}
						<DropdownMenu.RadioItem value={option.value} disabled={updateState.pending}>
							<span class="flex items-center gap-2">
								{@render swatchDot(option.value)}
								{option.label}
							</span>
						</DropdownMenu.RadioItem>
					{/each}
				</DropdownMenu.RadioGroup>
			{:else}
				{#each props.options as option (option.value)}
					<DropdownMenu.CheckboxItem
						checked={props.selected.includes(option.value)}
						onCheckedChange={(checked) => updateMulti(option.value, checked === true)}
						closeOnSelect={false}
						disabled={updateState.pending}
					>
						{option.label}
					</DropdownMenu.CheckboxItem>
				{/each}
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
