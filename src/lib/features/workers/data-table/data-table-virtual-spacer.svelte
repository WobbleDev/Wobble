<script lang="ts">
	import * as Table from '#lib/components/ui/table/index.ts';

	type Props = {
		height: number;
		colspan: number;
	};

	let { height, colspan }: Props = $props();
</script>

<Table.Row aria-hidden="true" class="border-0 hover:bg-transparent">
	<Table.Cell {colspan} class="border-0 p-0" style={`height: ${height}px`}></Table.Cell>
</Table.Row>
