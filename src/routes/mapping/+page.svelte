<script lang="ts">
	import WorkerRelationshipMap from '#lib/features/mapping/canvas/worker-relationship-map.svelte';
	import { personState } from '#lib/shared/person-state.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const person = $derived(personState.forWorksite(data.worksite?.id));
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col">
	<WorkerRelationshipMap
		workers={data.workers}
		attributes={data.attributes}
		languages={data.languages}
		agitations={data.agitations}
		{person}
	/>
</div>
