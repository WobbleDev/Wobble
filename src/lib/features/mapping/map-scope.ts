/** What the map's population is, as counts, and which empty state (if any) the counts call for. */

export type MapEmptyKind = 'worksite' | 'filters' | 'isolate';

export type MapScopeInput = {
	/** Workers in the active Worksite. */
	total: number;
	/** Workers the filters leave: the layout set. */
	layoutCount: number;
	/** The layout set narrowed by the Isolate focus: the set the screen-reader Map table lists. */
	visibleCount: number;
	isolatedInEffect: boolean;
};

/**
 * Which empty state the map shows, by precedence. An empty Worksite wins, because no filter
 * can help it. Filters that leave no Worker win over an empty Isolate, because Isolate cannot
 * show what the filters removed. An empty Isolate is exactly an Isolate focus that leaves
 * nobody drawn over a non-empty layout. Dots without Relationships are not an empty state.
 */
export function mapEmptyKind(input: MapScopeInput): MapEmptyKind | undefined {
	if (input.total === 0) return 'worksite';
	if (input.layoutCount === 0) return 'filters';
	if (input.visibleCount === 0 && input.isolatedInEffect) return 'isolate';
	return undefined;
}

export type MapScope = {
	total: number;
	/** The layout set: everyone the filters leave. */
	drawn: number;
	/** The Map table's set: the layout set narrowed by Isolate. */
	listed: number;
	/** Total minus drawn: what the filters hide. */
	hidden: number;
	/** Drawn minus listed: what Isolate leaves out. */
	isolatedAway: number;
};

export function mapScope(input: MapScopeInput): MapScope {
	return {
		total: input.total,
		drawn: input.layoutCount,
		listed: input.visibleCount,
		hidden: input.total - input.layoutCount,
		isolatedAway: input.layoutCount - input.visibleCount
	};
}
