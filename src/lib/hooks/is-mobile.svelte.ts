import { MediaQuery } from 'svelte/reactivity';

// The responsive ladder: three named width tiers, each owned by a surface
// family (see DESIGN.md — the Threshold Ladder Rule). Narrow reflows content,
// Compact releases the touch floor for forms, dialogs, Configuration and
// Mapping options, and Shell is the one structural threshold the navigation rail and
// the Workers table key to. The CSS tokens --breakpoint-sm/md/lg in layout.css must
// match these; a spec test pins all three. Nothing in the Workers table path may
// introduce a threshold other than Shell.
export const NARROW_BREAKPOINT = 640;
export const COMPACT_BREAKPOINT = 768;
export const SHELL_BREAKPOINT = 1024;

// The Workers table and the shell read this tier: below it the navigation rail becomes a
// drawer and the Workers table collapses to Name, Assessment, and the row
// actions.
// INTERIM: mobile breakpoint raised just below desktop floor (1024×640) so
// mobile never appears when the desktop floor is met. Revisit in development.
export class IsMobile extends MediaQuery {
	constructor() {
		super(`(max-width: ${SHELL_BREAKPOINT - 1}px) or (max-height: 639px)`);
	}
}
