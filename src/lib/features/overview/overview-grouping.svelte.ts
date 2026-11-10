/**
 * The Overview's grouping choice: which category Attribute the By Attribute bands and
 * the Agitations matrix read. The choice is address state (`by=`): changing it rewrites
 * the address in place, so a reload or a shared link opens the same reading. It falls
 * back to Department, then the first category, when the address names none or an
 * unknown one. The host supplies the categories, the address's starting value and the
 * address writer, so a literal host drives the spec.
 */
export interface OverviewGroupingHost<A extends { id: string; name: string }> {
	categories(): readonly A[];
	/** The `by` value the address opens with, or an empty string. */
	initial(): string;
	/** Rewrites the current address in place; the edit returns false to leave it alone. */
	replaceUrl(edit: (params: URLSearchParams) => boolean | void): void;
}

/** The Attribute a grouping value names, else Department, else the first category. */
export function resolveGroupingAttribute<A extends { id: string; name: string }>(
	categories: readonly A[],
	groupBy: string
): A | undefined {
	return (
		categories.find((a) => a.id === groupBy) ??
		categories.find((a) => a.name === 'Department') ??
		categories[0]
	);
}

export function createOverviewGrouping<A extends { id: string; name: string }>(
	host: OverviewGroupingHost<A>
) {
	let groupBy = $state(host.initial());
	const attribute = $derived(resolveGroupingAttribute(host.categories(), groupBy));

	function change(next: string) {
		if (!next) return;
		host.replaceUrl((params) => {
			if (params.get('by') === next) return false;
			params.set('by', next);
		});
	}

	return {
		get groupBy() {
			return groupBy;
		},
		set groupBy(next: string) {
			groupBy = next;
		},
		get attribute() {
			return attribute;
		},
		change
	};
}
