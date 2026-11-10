<script lang="ts">
	import ConfigurationEditor from '#lib/features/configuration/configuration-editor.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

{#if data.worksite}
	<ConfigurationEditor
		attributes={data.attributes}
		agitations={data.agitations}
		languages={data.languages}
		worksite={data.worksite}
		worksiteCount={data.worksites.length}
		workerCount={data.workers.length}
		workers={data.workers}
	/>
{/if}
