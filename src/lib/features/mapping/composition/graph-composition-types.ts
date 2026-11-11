/**
 * The composer's result types: a candidate's report, the selected packet, the
 * positions result and the composer handle.
 */
import type { Point } from '../graph-layout.ts';
import type { Route } from '../graph-relationship-routing.ts';
import type { HeadingPlacement, NamePlacement } from './graph-composition-drawing.ts';

export type CandidateReport = {
	key: string;
	status: 'selected' | 'valid' | 'rejected';
	reason?: string;
	conflicts: number;
	shallowOrShared: number;
	crossings: number;
	totalLength: number;
	scale: number;
	/** Pairs the router could not detour, with the obstacle that still blocks each. */
	unresolved?: string[];
	/** The selection key: conflicts, shallow or shared runs, crossings, normalized length, aspect, displacement. */
	rank?: number[];
};

/** The selected, complete drawing's non-position half. */
export type CompositionPacket = {
	/** Which candidate won: `original`, `routed`, `compress`, `aspect`, with `+r1`/`+r2` after a repair. */
	chosen: string;
	/** The reference fit (CSS pixels per map unit) the packet's text and clearances were built at. */
	scale: number;
	/** The extent the camera frames, in map units: dots, outlines and headings. */
	frame: { x: number; y: number; width: number; height: number };
	/**
	 * Final complete paths, one per eligible pair; absent only when the shipped ties
	 * stand straight, because routing them bought nothing or ran out of allowance.
	 */
	routes: ReadonlyMap<string, Route> | undefined;
	names: ReadonlyMap<string, NamePlacement>;
	headings: ReadonlyMap<string, HeadingPlacement>;
	/** Conflict identities left in the selected drawing, by category. */
	conflicts: {
		dot: string[];
		name: string[];
		heading: string[];
		region: string[];
		layout: string[];
	};
	candidates: CandidateReport[];
	textSource: 'measured' | 'estimate';
	work: { placement: number; routing: number; evaluation: number };
	/** Bumped whenever a different geometry is published. */
	revision: number;
};

export type ComposeResult = {
	positions: Map<string, Point>;
	centres: Map<string, Point>;
	packet: CompositionPacket;
};
