<script lang="ts">
	/**
	 * The record panel's ordinary Attributes: one row per configured Attribute, in
	 * configured order, each reading and edited where it is shown. Single-Select holds
	 * one answer or none; Multi-Select holds several distinct answers or none; the
	 * same-named nested values are tellable by their existing path labels.
	 *
	 * New Worker renders the same rows in `pending` mode, so the organizer chooses
	 * the Attributes the create request will carry.
	 */
	import type {
		Worker,
		WorkerAttributeDefinition,
		WorkerAttributeValue
	} from '#lib/domain-vocabulary.ts';
	import type { DataTableEditReport } from '../data-table/data-table-features.ts';
	import RecordPanelAttribute from './record-panel-attribute.svelte';
	import { m } from '#lib/paraglide/messages.js';

	let {
		worker,
		attributes,
		headingId,
		mode = 'saved',
		refresh,
		onSaved,
		onUpdate,
		onPendingChange
	}: {
		worker: Worker;
		attributes: readonly WorkerAttributeDefinition[];
		headingId: string;
		mode?: 'saved' | 'pending';
		refresh?: () => Promise<void>;
		onSaved?: (report: DataTableEditReport) => void;
		onUpdate?: (attributeId: string, value: WorkerAttributeValue) => Promise<void>;
		onPendingChange?: (attributeId: string, value: WorkerAttributeValue) => void;
	} = $props();
</script>

{#if attributes.length > 0}
	<section aria-labelledby={headingId} class="grid gap-3">
		<h3 id={headingId} class="label">{m.workers_attributes_heading()}</h3>
		<dl class="grid gap-3">
			{#each attributes as attribute (attribute.id)}
				<RecordPanelAttribute
					{worker}
					{attribute}
					{mode}
					refresh={refresh ?? (async () => {})}
					{onSaved}
					onUpdate={onUpdate ? (value) => onUpdate(attribute.id, value) : undefined}
					onPendingChange={onPendingChange
						? (value) => onPendingChange(attribute.id, value)
						: undefined}
				/>
			{/each}
		</dl>
	</section>
{/if}
