import type { Point } from '../graph-layout.ts';
import type { Route } from './graph-relationship-routing.ts';
import { findBundles, type TrackRoute } from './graph-track-corridors.ts';
import { buildBundlePaths, type MemberPath } from './graph-track-paths.ts';
import { WorkExhausted, type WorkBudget } from '../graph-work-budget.ts';

/** A tracked tie may grow at most this much over its untracked length; more reads as a detour, not a lane. */
const maxLengthGrowth = 1.05;

export type TrackMetrics = {
	properCrossings: number;
	shallowCrossings: number;
	/** Identity of every unresolved obstacle conflict (any category), e.g. 'tie:obstacle'. */
	conflicts: ReadonlySet<string>;
	invalidRoutes: ReadonlySet<string>;
	/** Drawn length per route id. */
	lengths: ReadonlyMap<string, number>;
};

export type TrackStage = {
	routes: Map<string, Route>;
	unit: number;
	budget: WorkBudget;
	/** Whether the curve `d` for the tie with this id clears every obstacle (the router's own check), and keeps the planning clearance everywhere except round the tie's own `corners` (the original route's interior waypoints, already validated by the router). */
	validate: (id: string, d: string, corners: readonly Point[]) => boolean;
	/** Measures a whole candidate set with the layout-quality code. */
	measure: (routes: ReadonlyMap<string, Route>) => TrackMetrics;
};

function byId(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function polylineLength(points: readonly Point[]): number {
	let total = 0;
	for (let index = 0; index + 1 < points.length; index += 1) {
		total += Math.hypot(
			points[index + 1].x - points[index].x,
			points[index + 1].y - points[index].y
		);
	}
	return total;
}

/** Whether the candidate is no worse than the current accepted set, and no tracked tie grew past the allowance. */
function acceptable(
	candidate: TrackMetrics,
	current: TrackMetrics,
	baseline: TrackMetrics,
	ids: readonly string[]
): boolean {
	return (
		candidate.properCrossings <= current.properCrossings &&
		candidate.shallowCrossings <= current.shallowCrossings &&
		[...candidate.conflicts].every((conflict) => current.conflicts.has(conflict)) &&
		[...candidate.invalidRoutes].every((id) => current.invalidRoutes.has(id)) &&
		ids.every((id) => {
			const grown = candidate.lengths.get(id);
			const original = baseline.lengths.get(id);
			return grown !== undefined && original !== undefined && grown <= maxLengthGrowth * original;
		})
	);
}

/** Moves long near-parallel ties into parallel lanes; returns `stage.routes` itself (same object) when nothing is tracked or the work allowance runs out. */
export function applyTracks(stage: TrackStage): Map<string, Route> {
	try {
		return trackBundles(stage);
	} catch (error) {
		if (error instanceof WorkExhausted) return stage.routes;
		throw error;
	}
}

function trackBundles(stage: TrackStage): Map<string, Route> {
	const candidates = [...stage.routes.values()].filter(
		(route) => route.blockers.length === 0 && !route.failure
	);
	const trackRoutes: TrackRoute[] = candidates.map((route) => ({
		id: route.id,
		source: route.source,
		target: route.target,
		waypoints: route.waypoints
	}));
	const trackRouteMap = new Map(trackRoutes.map((route) => [route.id, route]));
	const bundles = findBundles(trackRoutes, stage.unit, stage.budget);
	if (bundles.length === 0) return stage.routes;

	const baseline = stage.measure(stage.routes);
	let routes = stage.routes;
	let metrics = baseline;
	let applied = false;
	for (const bundle of bundles) {
		let members = bundle;
		let paths: MemberPath[] | undefined;
		for (;;) {
			paths = buildBundlePaths(trackRouteMap, members, stage.unit, stage.budget);
			if (!paths) break;
			const bad = new Set(
				paths
					.filter(
						(path) =>
							!stage.validate(path.id, path.d, stage.routes.get(path.id)!.waypoints.slice(1, -1))
					)
					.map((path) => path.id)
			);
			if (bad.size === 0) break;
			members = paths.filter((path) => !bad.has(path.id)).map((path) => path.id);
			if (members.length < 2) {
				paths = undefined;
				break;
			}
		}
		if (!paths) continue;

		const ids = paths.map((path) => path.id);
		const first = ids.toSorted(byId)[0];
		const candidate = new Map(routes);
		for (const path of paths) {
			const route = stage.routes.get(path.id)!;
			candidate.set(path.id, {
				...route,
				d: path.d,
				waypoints: path.waypoints,
				length: polylineLength(path.waypoints),
				direct: false,
				blockers: [],
				track: { bundle: first, lane: path.lane }
			});
		}
		const next = stage.measure(candidate);
		if (acceptable(next, metrics, baseline, ids)) {
			routes = candidate;
			metrics = next;
			applied = true;
		}
	}
	return applied ? routes : stage.routes;
}
