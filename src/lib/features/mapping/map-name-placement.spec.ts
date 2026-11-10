// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { decodeWorksiteDataset } from '#lib/client/dataset-api.ts';
import { cliquesWorksite, hubBundleWorksite } from '../../../../e2e/mapping-composition-dataset.ts';
import leaderHubBundle from '../../../../e2e/fixtures/mapping-leader-hub-bundle.json' with { type: 'json' };
import { worksiteGraph } from './composition-worksite-fixture.ts';
import {
	freeNamedMap,
	isolatedNames,
	standoff,
	type FreeNamedMap,
	type Placed
} from './free-name-fixture.ts';
import { thawName } from './map-frozen-names.ts';
import { buildWorkerGraph } from './worker-relationship-map-model.ts';
import {
	floatingKeyBoxes,
	keptNames,
	legacyPlacements,
	nameNodes,
	placeAllNames,
	restingNameBoxes,
	wholeMapViewport,
	type NameScene
} from './map-name-placement.ts';
import type { MapViewModel } from './map-view-model.ts';
import type { WorkerGraphNode } from './worker-relationship-map-model.ts';

const node = (id: string, name: string, relationshipCount = 0) =>
	({ id, name, relationshipCount, attributes: {}, assessment: 'Unassessed' }) as WorkerGraphNode;

const ana = node('a', 'Ana', 2);
const ben = node('b', 'Ben', 1);
const cy = node('c', 'Cy', 1);

/** A Free map of three Workers, two close together; every name stands at rest. */
function freeScene(overrides: Partial<NameScene> = {}, view: Partial<MapViewModel> = {}) {
	const visibleNodes = [ana, ben, cy];
	const positions = new Map([
		['a', { x: 0, y: 0 }],
		['b', { x: 40, y: 0 }],
		['c', { x: 300, y: 200 }]
	]);
	const ids = new Set(visibleNodes.map((n) => n.id));
	const viewModel = {
		visibleNodes,
		visibleLinks: [{ id: 'a-b', source: 'a', target: 'b', value: 1 }],
		labelIds: ids,
		restingLabelIds: ids,
		selectedId: '',
		hoveredId: '',
		isolated: false,
		ghostedIds: new Set<string>(),
		spotlightIds: new Set<string>(),
		highlightIds: undefined,
		...view
	} as unknown as MapViewModel;
	const camera = { zoom: 1, panX: 0, panY: 0 };
	const scene: NameScene = {
		viewModel,
		grouped: false,
		composed: false,
		radiusFor: () => 8,
		textSnapshot: undefined,
		regions: [],
		counts: new Map(),
		drawn: positions,
		settledPositions: positions,
		nameBounds: undefined,
		camera: () => camera,
		viewport: () => undefined,
		chrome: () => [],
		chromeAtFit: () => [],
		routeSegments: undefined,
		atReference: false,
		...overrides
	};
	return scene;
}

describe('nameNodes', () => {
	it('lists the drawn Workers among the ids, busiest first then by id', () => {
		const scene = freeScene();
		expect(nameNodes(scene, ['c', 'b', 'a', 'gone']).map((n) => n.id)).toEqual(['a', 'b', 'c']);
	});
});

describe('Free name placement', () => {
	it('gives every standing name a place, and no two names overlap', () => {
		const scene = freeScene();
		const placed = legacyPlacements(scene, undefined);
		expect([...placed.keys()].sort()).toEqual(['a', 'b', 'c']);

		const boxes = restingNameBoxes(scene, 1, { x: -50, y: -50, width: 400, height: 300 });
		expect(boxes).toHaveLength(3);
		for (let i = 0; i < boxes.length; i += 1) {
			for (let j = i + 1; j < boxes.length; j += 1) {
				const a = boxes[i];
				const b = boxes[j];
				const apart =
					a.x + a.width <= b.x ||
					b.x + b.width <= a.x ||
					a.y + a.height <= b.y ||
					b.y + b.height <= a.y;
				expect(apart).toBe(true);
			}
		}
	});

	it('places the names at fixed spots for fixed input', () => {
		const placed = legacyPlacements(freeScene(), undefined);
		const spots = [...placed].map(([id, p]) => [id, p.side, p.textAnchor, p.x, p.y]);
		expect(spots).toMatchInlineSnapshot(`
			[
			  [
			    "a",
			    "below",
			    "middle",
			    0,
			    24,
			  ],
			  [
			    "b",
			    "below",
			    "middle",
			    40,
			    24,
			  ],
			  [
			    "c",
			    "below",
			    "middle",
			    300,
			    224,
			  ],
			]
		`);
	});

	it('keeps a standing name on its kept side and ring when zoomed', () => {
		const scene = freeScene();
		const kept = keptNames(scene, { zoom: 1, panX: 0, panY: 0 });
		expect([...kept.keys()].sort()).toEqual(['a', 'b', 'c']);
		const zoomed = freeScene({ camera: () => ({ zoom: 2, panX: 0, panY: 0 }) });
		const replayed = legacyPlacements(zoomed, kept);
		for (const [id, spot] of kept) expect(replayed.get(id)?.side).toBe(spot.side);
	});

	it('draws only the names the visibility policy shows', () => {
		const scene = freeScene({}, { labelIds: new Set(['a']) });
		expect([...placeAllNames(scene, undefined, undefined).keys()]).toEqual(['a']);
	});
});

describe('floating keys', () => {
	const input = {
		floating: true,
		width: 800,
		height: 600,
		keySize: { width: 100, height: 40 },
		dotKeySize: { width: 60, height: 30 }
	};

	it('are none below the floating breakpoint', () => {
		expect(floatingKeyBoxes({ ...input, floating: false }, { zoom: 1, panX: 0, panY: 0 })).toEqual(
			[]
		);
	});

	it('sit in the bottom corners, 12px in, padded 2px, in map units', () => {
		expect(floatingKeyBoxes(input, { zoom: 1, panX: 0, panY: 0 })).toEqual([
			{ left: -390, right: -286, top: 246, bottom: 290 },
			{ left: 326, right: 390, top: 256, bottom: 290 }
		]);
		// At 2x the same screen box covers half the map units.
		expect(floatingKeyBoxes(input, { zoom: 2, panX: 0, panY: 0 })[0]).toEqual({
			left: -195,
			right: -143,
			top: 123,
			bottom: 145
		});
	});
});

describe('wholeMapViewport', () => {
	const chrome = { top: 0, right: 0, bottom: 0, left: 0 };
	const base = {
		isolated: false,
		framedZoom: 1,
		surface: { width: 800, height: 600 },
		chrome
	};

	it('is the usable canvas in map units at the framed zoom', () => {
		expect(wholeMapViewport({ ...base, camera: { zoom: 1, panX: 0, panY: 0 } })).toEqual({
			left: -400,
			right: 400,
			top: -300,
			bottom: 300
		});
	});

	it('is absent in Isolate and once zoomed more than 2% away from the framing', () => {
		expect(
			wholeMapViewport({ ...base, isolated: true, camera: { zoom: 1, panX: 0, panY: 0 } })
		).toBe(undefined);
		expect(wholeMapViewport({ ...base, camera: { zoom: 1.03, panX: 0, panY: 0 } })).toBe(undefined);
	});
});

describe('narrow canvases', () => {
	const ids = Array.from({ length: 10 }, (_, index) => `n${index}`);

	/** Ten Workers piled on one dot with long names, at a phone's fit zoom. */
	function crowdedScene(
		narrow: boolean,
		options: { selectedId?: string; restingIds?: string[] } = {}
	): NameScene {
		const nodes = ids.map((id) => node(id, `Henri Marie ${id.slice(1)}`));
		const positions = new Map(nodes.map((worker) => [worker.id, { x: 0, y: 0 }]));
		return freeScene(
			{
				narrow,
				camera: () => ({ zoom: 0.15, panX: 0, panY: 0 }),
				drawn: positions,
				settledPositions: positions
			},
			{
				visibleNodes: nodes,
				visibleLinks: [],
				labelIds: new Set(ids),
				restingLabelIds: new Set(options.restingIds ?? ids),
				selectedId: options.selectedId ?? ''
			}
		);
	}

	it('drops resting names rather than drawing them over one another', () => {
		const wide = legacyPlacements(crowdedScene(false), undefined);
		const narrow = legacyPlacements(crowdedScene(true), undefined);

		// The wide reading still places every name (the documented least-crowded fallback);
		// the narrow reading leaves an unplaceable name off rather than overprinting it.
		expect(wide.size).toBe(10);
		expect(narrow.size).toBeGreaterThan(0);
		expect(narrow.size).toBeLessThan(wide.size);
	});

	it('keeps a selected name that the resting cap does not hold', () => {
		const scene = crowdedScene(true, {
			selectedId: 'n9',
			restingIds: ids.filter((id) => id !== 'n9')
		});
		expect(legacyPlacements(scene, undefined).has('n9')).toBe(true);
	});
});

/** The names as the map draws them at rest: each frozen name thawed at the framing's zoom. */
function drawnAtRest(map: FreeNamedMap): Map<string, Placed> {
	return new Map(
		[...map.frozen].map(([id, frozen]) => [
			id,
			thawName(
				frozen,
				map.positions.get(id)!,
				map.radiusFor(map.nodeById.get(id)!),
				map.camera.zoom
			)
		])
	);
}

describe('leaders on a Free map', () => {
	it('draws a leader to a displaced name and none for a name beside its dot', () => {
		// A narrow canvas holds the crowded hub at the zoom floor, so the long names around it
		// do not all fit beside their dots.
		const map = freeNamedMap(worksiteGraph(hubBundleWorksite()), { width: 390, height: 780 });
		const names = [...drawnAtRest(map)].map(([id, name]) => ({
			id,
			name,
			standoff: standoff(map.dot(id), name.box)
		}));
		const unit = 1 / map.camera.zoom;
		expect(names.length, 'names are shown').toBeGreaterThan(0);
		// The nearest name sits at its dot's edge (12 pixels is the leader threshold) and
		// carries no leader.
		const nearest = names.reduce((a, b) => (a.standoff <= b.standoff ? a : b));
		expect(nearest.standoff, 'a name sits beside its dot').toBeLessThan(13 * unit);
		expect(nearest.name.leader, 'no leader for a name beside its dot').toBeUndefined();
		// A name pushed out to read points back at the dot it belongs to.
		for (const entry of names.filter((e) => e.standoff > 16 * unit))
			expect(entry.name.leader, `${entry.id} needs a leader`).toBeDefined();
		// Every leader belongs to a name that really stands off, never one beside its dot.
		for (const entry of names.filter((e) => e.name.leader))
			expect(entry.standoff, `${entry.id} stands off`).toBeGreaterThan(11 * unit);
	});

	it('draws a leader from a standing-off name back to its own dot', () => {
		// The captured crowded arrangement at a width where the whole-map fit reaches the zoom
		// floor: the crowded hub cannot fit every long name beside its dot, so at least one
		// stands off and must prove its leader.
		const dataset = decodeWorksiteDataset(leaderHubBundle.dataset);
		const map = freeNamedMap(buildWorkerGraph(dataset.workers), { width: 320, height: 600 });
		const names = [...drawnAtRest(map)].map(([id, name]) => ({
			id,
			name,
			standoff: standoff(map.dot(id), name.box)
		}));
		const unit = 1 / map.camera.zoom;
		expect(names.length, 'names are shown').toBeGreaterThan(0);
		expect(
			names.filter((e) => e.name.leader).length,
			'a viewport at the zoom floor pushes at least one name off its dot'
		).toBeGreaterThan(0);
		for (const entry of names.filter((e) => e.standoff > 16 * unit)) {
			const dot = map.dot(entry.id);
			const line = entry.name.leader;
			expect(line, `${entry.id} shows a leader`).toBeDefined();
			// The leader runs from this name's own dot's surface to its own name box.
			const tolerance = 2 * unit;
			expect(
				Math.abs(Math.hypot(line!.x1 - dot.x, line!.y1 - dot.y) - dot.r),
				`${entry.id}'s leader starts at its dot's surface`
			).toBeLessThan(tolerance);
			const { box } = entry.name;
			expect(line!.x2, `${entry.id}'s leader ends on its box`).toBeGreaterThanOrEqual(
				box.left - tolerance
			);
			expect(line!.x2).toBeLessThanOrEqual(box.right + tolerance);
			expect(line!.y2).toBeGreaterThanOrEqual(box.top - tolerance);
			expect(line!.y2).toBeLessThanOrEqual(box.bottom + tolerance);
		}
		// A name beside its dot never gets a leader, however many names share the neighbourhood.
		for (const entry of names.filter((e) => e.standoff < 11 * unit))
			expect(entry.name.leader, `${entry.id} needs no leader`).toBeUndefined();
	});

	for (const [slug, worksite] of [
		['cliques', cliquesWorksite()],
		['hub-bundle', hubBundleWorksite()]
	] as const) {
		it(`keeps names near their dot or connects a displaced name with a leader (${slug})`, () => {
			const map = freeNamedMap(worksiteGraph(worksite), { width: 1600, height: 1000 });
			const names = drawnAtRest(map);
			const unit = 1 / map.camera.zoom;
			// Four standard gaps: the screen-fixed reach a Free name may travel from its dot.
			const cap = 32 * unit;
			expect(names.size, 'names are shown').toBeGreaterThan(0);
			for (const [id, name] of names) {
				if (standoff(map.dot(id), name.box) > cap + 0.5 * unit)
					expect(
						name.leader,
						`${id} remains attached when initial placement needs more room`
					).toBeDefined();
			}
		});
	}
});

/** The stored Relationships' neighbours of the Worker, and whether a name is shown for each. */
const fixtures = [
	['cliques', cliquesWorksite()],
	['hub-bundle', hubBundleWorksite()]
] as const;

/** The Worker without a resting name whose neighbourhood holds the most named Workers. */
function unnamedWorkerNearNamed(map: FreeNamedMap) {
	return map.nodes
		.filter((node) => !map.placed.has(node.id))
		.map((node) => ({
			id: node.id,
			namedNeighbours: [...map.neighbours.get(node.id)!].filter((id) => map.placed.has(id))
		}))
		.sort((a, b) => b.namedNeighbours.length - a.namedNeighbours.length)[0]!;
}

/**
 * Every name placed before is still placed, each holding its exact box. A name may be
 * hidden only when the spotlight rule says so: selection and hover deliberately hide
 * everyone outside the active Worker's neighbourhood.
 */
function expectNamesHeld(
	before: ReadonlyMap<string, Placed>,
	after: ReadonlyMap<string, Placed>,
	when: string,
	hiddenBySpotlight: (id: string) => boolean
): number {
	let kept = 0;
	for (const [id, name] of before) {
		const now = after.get(id);
		if (!now) {
			expect(hiddenBySpotlight(id), `${when} name ${id} is only hidden by the spotlight`).toBe(
				true
			);
			continue;
		}
		kept += 1;
		expect(now.box.left, `${when} name ${id} holds its place`).toBeCloseTo(name.box.left, 1);
		expect(now.box.top, `${when} name ${id} holds its place`).toBeCloseTo(name.box.top, 1);
	}
	return kept;
}

describe('placeAllNames with keptNames when a Worker is hovered or selected in Free', () => {
	for (const [slug, worksite] of fixtures) {
		for (const action of ['hovered', 'selected'] as const) {
			it(`keeps the other names in place when a Worker is ${action} (${slug})`, () => {
				const map = freeNamedMap(worksiteGraph(worksite), { width: 1600, height: 1000 });
				const before = map.placed;
				const target = unnamedWorkerNearNamed(map);
				expect(
					target.namedNeighbours.length,
					`the ${action} Worker has a named neighbour`
				).toBeGreaterThan(0);
				const after = placeAllNames(
					map.sceneAt(
						map.camera,
						action === 'hovered' ? { hoveredId: target.id } : { selectedId: target.id }
					),
					undefined,
					map.kept
				);
				// The active name is placed after the resting ones, so none of them yields its box.
				// The spotlight intentionally hides names outside the active Worker's neighbourhood;
				// every name it keeps must hold exactly its place, and no neighbour may vanish.
				const neighbours = map.neighbours.get(target.id)!;
				expect(expectNamesHeld(before, after, action, (id) => !neighbours.has(id))).toBeGreaterThan(
					0
				);
				// Pointing adds information: the Worker's name appears, and a named neighbour keeps hers.
				expect(after.has(target.id), `the ${action} name appears`).toBe(true);
				for (const id of target.namedNeighbours)
					expect(after.has(id), `named neighbour ${id} keeps its name`).toBe(true);
			});
		}
	}

	it('keeps the other names in place when a Worker is hovered in Isolate', () => {
		const graph = worksiteGraph(cliquesWorksite());
		const anchor = graph.ids[0];
		const isolate = isolatedNames(graph, { width: 1600, height: 1000 }, anchor);
		const before = placeAllNames(isolate.sceneFor(), undefined, undefined);
		expect(before.size, 'the Isolate names its neighbourhood').toBeGreaterThan(1);
		// The first named Worker in drawing order, as the page lists them.
		const other = isolate.visibleNodes.find(
			(node) => before.has(node.id) && node.id !== anchor
		)!.id;
		const hovered = placeAllNames(isolate.sceneFor(other), undefined, undefined);
		expect(hovered.has(other), 'the hovered name is drawn').toBe(true);

		// Isolate names every drawn Worker; the hover's spotlight still hides non-neighbours.
		// Every name it keeps holds its place, and only non-neighbours may be hidden.
		const others = new Map([...before].filter(([id]) => id !== other));
		const neighbours = isolate.neighbours.get(other)!;
		expect(
			expectNamesHeld(others, hovered, 'hovered', (id) => !neighbours.has(id))
		).toBeGreaterThan(1);
	});
});
