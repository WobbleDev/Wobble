// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { Drawing } from './graph-composition-drawing.ts';
import { evaluateDrawing, publishedConflicts } from '../layout/graph-layout-quality.ts';
import type { DrawingEvaluation } from '../layout/graph-layout-quality.ts';
import type { Route } from '../routing/graph-relationship-routing.ts';
import { packetOf } from './graph-composition-selection.ts';

type PacketArgs = Parameters<typeof packetOf>;

/** A route carrying only what the packet publishes and a reading flattens. */
const route = (id: string, d: string): Route =>
	({
		id,
		source: 'a',
		target: 'b',
		d,
		waypoints: [],
		length: 0,
		direct: true,
		blockers: []
	}) as unknown as Route;

/** A drawing reading with every conflict category empty unless overridden. */
const evaluation = (overrides: Partial<DrawingEvaluation> = {}): DrawingEvaluation => ({
	dotConflicts: [],
	nameConflicts: [],
	headingConflicts: [],
	regionConflicts: [],
	layoutConflicts: [],
	invalidRoutes: [],
	outlineGap: Infinity,
	properCrossings: 0,
	shallowCrossings: 0,
	sharedRuns: 0,
	totalLength: 0,
	longestLength: 0,
	routeLengths: new Map(),
	...overrides
});

const ctx = {
	text: { source: 'estimate' },
	budget: { used: { placement: 0, routing: 0, evaluation: 0 } }
} as unknown as PacketArgs[0];
const sel = { reports: [] } as unknown as PacketArgs[1];
const winner = {
	layout: { positions: new Map(), centres: new Map() },
	scale: 1,
	extent: { left: 0, top: 0, right: 0, bottom: 0 },
	names: new Map(),
	headings: new Map()
} as unknown as PacketArgs[2];
const drawing = (overrides: Record<string, unknown>): Drawing =>
	({ routes: new Map(), evaluation: evaluation(), ...overrides }) as unknown as Drawing;

describe('packetOf', () => {
	it('publishes the conflicts of the routes it publishes, not the pre-tidy reading', () => {
		// A detoured lane is tidied into a reserved name corner: the drawing was read before
		// the tidy, so its conflicts never mention that name. The published report must.
		const routes = new Map([['ab', route('ab', 'M 0 0 L 10 0')]]);
		const tidied = new Map([['ab', route('ab', 'M 0 0 Q 5 3 10 0')]]);
		const before = evaluation();
		const after = evaluation({
			nameConflicts: ['ab:name:z'],
			headingConflicts: ['ab:heading'],
			dotConflicts: ['ab:q']
		});
		const result = packetOf(
			ctx,
			sel,
			winner,
			'composed',
			drawing({
				routes,
				evaluation: before,
				finalize: () => ({ routes: tidied, evaluation: after })
			})
		);
		// Vacuity guard: the two readings really differ, and the pre-tidy one is strictly smaller.
		expect(before.nameConflicts.length).toBe(0);
		expect(after.nameConflicts.length).toBeGreaterThan(before.nameConflicts.length);
		expect(result.packet.routes).toBe(tidied);
		expect(result.packet.conflicts).toEqual({
			dot: after.dotConflicts,
			name: after.nameConflicts,
			heading: after.headingConflicts,
			region: after.regionConflicts,
			layout: after.layoutConflicts
		});
	});

	it('keeps the drawing reading when nothing was tidied', () => {
		const routes = new Map([['ab', route('ab', 'M 0 0 L 10 0')]]);
		const before = evaluation({ regionConflicts: ['ab:region'] });
		const result = packetOf(ctx, sel, winner, 'original', drawing({ routes, evaluation: before }));
		expect(result.packet.routes).toBe(routes);
		expect(result.packet.conflicts.region).toEqual(['ab:region']);
	});
});

type DrawingNames = Parameters<typeof evaluateDrawing>[0]['names'];
type DrawingRoutes = Parameters<typeof evaluateDrawing>[0]['routes'];

/** The name contacts an independent reading of a route set finds against these boxes. */
function nameContacts(routes: DrawingRoutes, names: DrawingNames): string[] {
	return evaluateDrawing({
		routes,
		dots: [],
		names,
		headings: [],
		regions: [],
		workerRegions: new Map(),
		unit: 1,
		skipLayoutConflicts: true
	}).nameConflicts;
}

describe('render-time name-box conflicts', () => {
	it('publishes the name contacts of the boxes the renderer placed, not the packet boxes', () => {
		// One route runs straight through the spot where the renderer re-places the name.
		const routes: DrawingRoutes = [{ id: 'ab', source: 'a', target: 'b', d: 'M 0 0 L 10 0' }];
		const packet = packetOf(
			ctx,
			sel,
			winner,
			'composed',
			drawing({
				routes: new Map([['ab', route('ab', 'M 0 0 L 10 0')]]),
				evaluation: evaluation()
			})
		).packet;
		// A third Worker's name: the route's own endpoints' names are exempt.
		const packetNames: DrawingNames = [
			{ id: 'name:c', worker: 'c', box: { left: 20, top: 20, right: 30, bottom: 30 } }
		];
		const renderedNames: DrawingNames = [
			{ id: 'name:c', worker: 'c', box: { left: 2, top: -2, right: 8, bottom: 2 } }
		];
		// Vacuity guards: the packet reading is clear, the rendered one is not, and they differ.
		expect(nameContacts(routes, packetNames)).toEqual([]);
		expect(nameContacts(routes, renderedNames)).toEqual(['ab:name:c']);
		const published = publishedConflicts({
			conflicts: packet.conflicts,
			drawing: {
				routes,
				dots: [],
				names: renderedNames,
				headings: [],
				regions: [],
				workerRegions: new Map(),
				unit: 1,
				skipLayoutConflicts: true
			}
		});
		expect(published.name).toEqual(['ab:name:c']);
	});
});
