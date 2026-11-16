<script lang="ts">
	/**
	 * The search field at the top of a bulk-bar menu. Shared by the Attributes
	 * chooser and Edit languages so both read and behave alike.
	 */
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';

	let { label, value = $bindable() }: { label: string; value: string } = $props();
</script>

<DropdownMenu.Group>
	<div class="px-1.5 pt-1.5 pb-0.5">
		<Input
			type="search"
			aria-label={label}
			placeholder={label}
			bind:value
			onkeydown={(event) => {
				// The menu's own typeahead must not steal the search
				// field's keys; Escape still closes the menu.
				if (event.key !== 'Escape') event.stopPropagation();
			}}
			class="min-h-tap lg:min-h-8"
		/>
	</div>
</DropdownMenu.Group>
<DropdownMenu.Separator />
