// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { decodeWorksiteDataset } from '#lib/client/dataset-api.ts';
import { arrange, type ArrangeInput } from '../graph-arrangement.ts';
import type { Box } from './graph-label-placement.ts';
import { keptNames, legacyPlacements, type NameScene } from './map-name-placement.ts';
import { regionCounts } from '../map-reading.ts';
import { nodeRadius } from '../map-style.ts';
import type { MapViewModel } from '../map-view-model.ts';
import { buildWorkerGraph, type WorkerGraphNode } from '../worker-relationship-map-model.ts';
import collisionDotGrouped from '../../../../../e2e/fixtures/mapping-label-collision-dot-grouped.json' with { type: 'json' };
import collisionDotUngrouped from '../../../../../e2e/fixtures/mapping-label-collision-dot-ungrouped.json' with { type: 'json' };
import collisionSeed11 from '../../../../../e2e/fixtures/mapping-label-collision-seed-11.json' with { type: 'json' };
import collisionSeed13 from '../../../../../e2e/fixtures/mapping-label-collision-seed-13.json' with { type: 'json' };

/**
 * Name clearance on the captured collision fixtures, replayed through the same
 * arrangement and name placement the canvas runs, at the reference camera (one
 * map unit per screen pixel). The browser spec keeps the DOM reading of the same
 * rules; this file owns the arithmetic.
 */

/** A dot's stroke is part of its box: a graze of two pixels is not a collision. */
const dotShrink = 2;
/** A Free name stands within this many pixels of its dot's surface, or draws a leader. */
const freeReach = 32;
const canvas = { width: 1280, height: 800 };
const gap = 24;

const captured = [
	['seed 11', collisionSeed11],
	['seed 13', collisionSeed13],
	['dot overlap grouped capture', collisionDotGrouped],
	['dot overlap ungrouped capture', collisionDotUngrouped]
] as const;

const states = ['ungrouped', 'grouped', 'subgrouped'] as const;

function overlaps(a: Box, b: Box): boolean {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The replay of one captured worksite in one view: the arrangement and the name scene. */
function replay(fixture: (typeof captured)[number][1], state: (typeof states)[number]) {
	const dataset = decodeWorksiteDataset(fixture.dataset);
	const { nodes, links } = buildWorkerGraph(dataset.workers);
	const grouping =
		state === 'ungrouped' ? undefined : dataset.attributes.find((a) => a.id === fixture.deptId);
	const subGrouping =
		state === 'subgrouped' ? dataset.attributes.find((a) => a.id === fixture.roleId) : undefined;
	const input: ArrangeInput = {
		mode: grouping ? 'grouped' : 'free',
		nodes,
		links,
		groupingAttribute: grouping,
		subGroupingAttribute: subGrouping,
		canvas,
		gap
	};
	const arrangement = arrange(input);
	const ids = new Set(nodes.map((node) => node.id));
	const viewModel = {
		visibleNodes: nodes,
		visibleLinks: links,
		layoutNodes: nodes,
		layoutLinks: links,
		labelIds: ids,
		restingLabelIds: ids,
		selectedId: '',
		hoveredId: '',
		isolated: false,
		ghostedIds: new Set<string>(),
		spotlightIds: new Set<string>(),
		highlightIds: undefined
	} as unknown as MapViewModel;
	const camera = { zoom: 1, panX: 0, panY: 0 };
	const scene: NameScene = {
		viewModel,
		grouped: grouping !== undefined,
		composed: false,
		radiusFor: (node: WorkerGraphNode) => nodeRadius(node.relationshipCount),
		textSnapshot: undefined,
		regions: arrangement.regions,
		counts: regionCounts(nodes, grouping, subGrouping),
		drawn: arrangement.positions,
		settledPositions: arrangement.positions,
		nameBounds: undefined,
		camera: () => camera,
		viewport: () => undefined,
		chrome: () => [],
		chromeAtFit: () => [],
		routeSegments: undefined,
		atReference: false
	};
	const kept = grouping ? undefined : keptNames(scene, camera);
	const placed = legacyPlacements(scene, kept);
	const dots = nodes.map((node) => {
		const point = arrangement.positions.get(node.id)!;
		return { id: node.id, x: point.x, y: point.y, r: nodeRadius(node.relationshipCount) };
	});
	const regionBoxes = arrangement.regions.flatMap((region) =>
		[region, ...region.subRegions].flatMap((label) =>
			label.labelBox
				? [
						{
							left: label.labelBox.x,
							top: label.labelBox.y,
							right: label.labelBox.x + label.labelBox.width,
							bottom: label.labelBox.y + label.labelBox.height
						}
					]
				: []
		)
	);
	return { nodes, dots, placed, regionBoxes };
}

describe.each(captured)('captured %s', (_, fixture) => {
	for (const state of states) {
		describe(state, () => {
			const view = replay(fixture, state);

			it("places every Worker's name", () => {
				expect(view.placed.size).toBe(view.nodes.length);
			});

			it('keeps every name clear of the other names and of the group headings', () => {
				const names = [...view.placed].map(([id, placement]) => ({ id, box: placement.box }));
				const hits: string[] = [];
				for (let i = 0; i < names.length; i += 1) {
					for (let j = i + 1; j < names.length; j += 1)
						if (overlaps(names[i].box, names[j].box)) hits.push(`${names[i].id} / ${names[j].id}`);
					for (const heading of view.regionBoxes)
						if (overlaps(names[i].box, heading)) hits.push(`${names[i].id} over a heading`);
				}
				expect(hits).toEqual([]);
			});

			it('keeps every name clear of every dot but its own', () => {
				const hits: string[] = [];
				for (const [id, placement] of view.placed) {
					for (const dot of view.dots) {
						if (dot.id === id) continue;
						const shrunk = {
							left: dot.x - dot.r + dotShrink,
							top: dot.y - dot.r + dotShrink,
							right: dot.x + dot.r - dotShrink,
							bottom: dot.y + dot.r - dotShrink
						};
						if (overlaps(placement.box, shrunk)) hits.push(`${id} over ${dot.id}`);
					}
				}
				expect(hits).toEqual([]);
			});

			if (state === 'ungrouped')
				it('stands every Free name within 32px of its dot, or draws a leader to it', () => {
					const unleadered: string[] = [];
					for (const [id, placement] of view.placed) {
						const dot = view.dots.find((candidate) => candidate.id === id)!;
						const nearestX = Math.max(placement.box.left, Math.min(dot.x, placement.box.right));
						const nearestY = Math.max(placement.box.top, Math.min(dot.y, placement.box.bottom));
						const standoff = Math.hypot(nearestX - dot.x, nearestY - dot.y) - dot.r;
						if (standoff > freeReach && placement.leader === undefined)
							unleadered.push(`${id} stands ${Math.round(standoff)}px off`);
					}
					expect(unleadered).toEqual([]);
				});
		});
	}
});
