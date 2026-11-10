<script lang="ts">
	/*
	 * An on/off control. The shadcn set in this repo has no switch, so this
	 * is a local one. The state is carried by position, and by the Check mark inside
	 * the track once it is on, not by colour alone. The hit area is padded out to the
	 * physical tap floor without growing the visible track.
	 */
	import Check from '@lucide/svelte/icons/check';
	import { getContext } from 'svelte';
	import { settingsRowContextKey, type SettingsRowContext } from './row-context.ts';

	let {
		checked = $bindable(false),
		disabled = false,
		labelledby,
		onchange
	}: {
		checked?: boolean;
		disabled?: boolean;
		labelledby: string;
		/** Called with the new state after a click; a controlled parent saves it here. */
		onchange?: (checked: boolean) => void;
	} = $props();

	/* The row owns which description IDs exist; a row without a description must not
	   leave a dangling IDREF here. */
	const row = getContext<SettingsRowContext | undefined>(settingsRowContextKey);

	function toggle() {
		/* A disabled switch ignores even a script-dispatched click, as a native control does. */
		if (disabled) return;

		checked = !checked;
		onchange?.(checked);
	}
</script>

<!-- Kept raw: the vendored switch has no check mark in its thumb and draws a different track, which would change the visible control. The 0.75rem padding inset makes the click target at least 45px tall even at Compact density (22.5px track plus two 11.25px insets) while the visible track stays 24px. -->
<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-labelledby={labelledby}
	aria-describedby={row?.describedby}
	{disabled}
	onclick={toggle}
	class="group/switch relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-rule-strong bg-inset transition-colors duration-150 outline-none before:absolute before:-inset-3 before:content-[''] hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid disabled:cursor-not-allowed disabled:opacity-50 aria-checked:border-action aria-checked:bg-action aria-checked:hover:bg-action-hover"
>
	<span
		aria-hidden="true"
		class="pointer-events-none ml-0.5 grid size-4.5 place-items-center rounded-full bg-ink-3 text-on-action transition-transform duration-150 group-aria-checked/switch:translate-x-5 group-aria-checked/switch:bg-on-action group-aria-checked/switch:text-action"
	>
		<Check
			class="size-3 opacity-0 transition-opacity duration-150 group-aria-checked/switch:opacity-100"
		/>
	</span>
</button>
