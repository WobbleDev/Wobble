# features/configuration

The Configuration view: where a Worksite defines itself — its name, the Attributes it asks
about its Workers, the Agitations and Languages they can hold, and its own deletion.

`configuration-draft.ts` holds the unsaved draft and its rules, and
`configuration-draft-state.svelte.ts` owns that draft for the visit — which is why the
sidebar can warn about unsaved changes before you switch Worksite.

Configuration belongs to one Worksite. Installation-wide Theme and Density are Settings.
