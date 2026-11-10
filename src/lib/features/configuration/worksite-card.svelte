<script lang="ts">
	import SectionCard from '#lib/shared/section-card.svelte';
	import CommitteeTargetEditor from './committee-target-editor.svelte';
	import WorksiteNameEditor from './worksite-name-editor.svelte';

	type Props = {
		name?: string;
		savedName: string;
		editing?: boolean;
		saving: boolean;
		dirty: boolean;
		committeeTarget?: string;
		committeeTargetError: string;
	};

	let {
		name = $bindable(''),
		savedName,
		editing = $bindable(false),
		saving,
		dirty,
		committeeTarget = $bindable(''),
		committeeTargetError
	}: Props = $props();
</script>

<!--
  The Worksite card: the name at the top and the Committee coverage target directly
  beneath it, because both describe this Worksite rather than anything inside it.
  It carries no deletion control; that lives in the danger zone at the foot.
-->
<SectionCard data-testid="worksite-card">
	<div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-6">
		<WorksiteNameEditor bind:name {savedName} bind:editing {saving} {dirty} />
		<CommitteeTargetEditor bind:committeeTarget error={committeeTargetError} {saving} />
	</div>
</SectionCard>
