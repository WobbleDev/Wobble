// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { ReportConflicts } from './layout/graph-layout-quality.ts';
import type { ReportDrawingSource } from './map-canvas-report.ts';
import { createPublishedReport } from './map-canvas-published-report.svelte.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';

const node = (id: string) =>
	({ id, name: id, attributes: {}, relationshipCount: 0 }) as unknown as WorkerGraphNode;
const packet: ReportConflicts = { dot: [], name: [], heading: [], region: [], layout: ['keep'] };

function source(): ReportDrawingSource {
	return {
		visibleNodes: [node('a'), node('b'), node('c')],
		visibleLinks: [{ id: 'ab', source: 'a', target: 'b', value: 1 } as unknown as WorkerGraphLink],
		positions: new Map([
			['a', { x: 0, y: 0 }],
			['b', { x: 10, y: 0 }],
			['c', { x: 50, y: 50 }]
		]),
		routes: undefined,
		radiusFor: () => 1,
		// c's name drawn across the straight a-b tie, which the packet never saw.
		placements: new Map([['c', { box: { left: 4, top: -2, right: 6, bottom: 2 } }]]),
		regions: [],
		textSnapshot: undefined,
		zoom: 1,
		groupingAttribute: undefined,
		subGroupingAttribute: undefined
	};
}

describe('published report', () => {
	it('is the packet reading until the scene is ready', () => {
		const report = createPublishedReport({
			ready: () => false,
			textVersion: () => 'measured',
			packetConflicts: () => packet,
			source
		});
		expect(report.conflicts).toBe(packet);
	});

	it('is undefined without a packet', () => {
		const report = createPublishedReport({
			ready: () => true,
			textVersion: () => undefined,
			packetConflicts: () => undefined,
			source
		});
		expect(report.conflicts).toBeUndefined();
	});

	it('re-reads route contacts from the drawn boxes once ready, keeping layout', () => {
		const report = createPublishedReport({
			ready: () => true,
			textVersion: () => 'measured',
			packetConflicts: () => packet,
			source
		});
		expect(report.conflicts?.name).toEqual(['ab:name:c']);
		expect(report.conflicts?.layout).toEqual(['keep']);
	});
});

describe('published report stability', () => {
	it('is read once per composition and text version, and ignores later camera changes', () => {
		let zoom = 1;
		let version = 'estimate';
		const report = createPublishedReport({
			ready: () => true,
			textVersion: () => version,
			packetConflicts: () => packet,
			source: () => ({ ...source(), zoom })
		});
		const first = report.conflicts;
		expect(report.published).toBe(true);
		zoom = 4;
		expect(report.conflicts).toBe(first);
		version = 'measured';
		expect(report.conflicts).not.toBe(first);
		expect(report.conflicts).toEqual(first);
	});
});
