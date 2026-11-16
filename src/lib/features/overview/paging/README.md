# overview/paging

How the Agitations and Breakdown cards split their groups into pages.

- `page-math.ts`: pure page arithmetic (slice groups, clamp an index, read the visible range).
- `reading-rows.ts`: pure whole-row paging for the Breakdown reading.
- `navigation.svelte.ts`: the page state, arrow-key turns and focus handling both cards share.
- `agitations-card.svelte.ts` and `breakdown-card.svelte.ts`: each card's measuring on top of the shared navigation.
