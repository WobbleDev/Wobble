<script lang="ts">
	/**
	 * The Filter panel's dropdown for one Attribute: each answer is listed by its
	 * text, but checked and toggled by its id.
	 */
	import { Badge } from '#lib/components/ui/badge/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.ts';
	import { m } from '#lib/paraglide/messages.js';

	type Props = {
		label: string;
		/**
		 * The accessible name when the visible label alone is ambiguous, for example an
		 * Include control beside the panel's show/hide control for the same Attribute.
		 */
		ariaLabel?: string;
		/**
		 * Every answer the Attribute holds, by id, with the text it shows. A system
		 * reading (a no-value condition) may add its explanatory text.
		 */
		options: readonly {
			id: string;
			label: string;
			description?: string | null;
			/** Nesting level of a hierarchical value; indents the label when above 0. */
			depth?: number;
		}[];
		/** The ids currently shown (checked). */
		selected: readonly string[];
		onToggle: (id: string, checked: boolean) => void;
	};

	let { label, ariaLabel, options, selected, onToggle }: Props = $props();
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				size="sm"
				class="min-h-tap lg:min-h-8"
				aria-label={ariaLabel}
			>
				{label}
				{#if selected.length}
					<Badge variant="secondary" class="num">{selected.length}</Badge>
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start">
		{#if options.length === 0}
			<DropdownMenu.Group>
				<div class="grid gap-0.5 px-2 py-1.5">
					<p class="text-sm text-muted-foreground">{m.mapping_nothing_set_up()}</p>
					<p class="text-sm text-muted-foreground">
						{m.mapping_add_in_configuration({ attribute: label })}
					</p>
				</div>
			</DropdownMenu.Group>
		{:else}
			<DropdownMenu.Group>
				{#each options as option (option.id)}
					<DropdownMenu.CheckboxItem
						checked={selected.includes(option.id)}
						aria-label={option.description
							? `${option.label} (${option.description})`
							: option.label}
						onCheckedChange={(checked) => onToggle(option.id, checked === true)}
						closeOnSelect={false}
					>
						<span class="flex flex-col">
							<span
								style:padding-left={option.depth && option.depth > 0
									? `${option.depth * 0.75}rem`
									: undefined}>{option.label}</span
							>
							{#if option.description}
								<span class="text-xs text-muted-foreground">{option.description}</span>
							{/if}
						</span>
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Group>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>
