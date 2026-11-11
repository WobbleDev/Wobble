// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { boundsOf } from './layout/graph-shapes.ts';
import type { GroupRegion, Point } from './layout/graph-layout.ts';
import type { TextSnapshot } from './labels/graph-text-metrics.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';
import { reportDrawingInput } from './map-canvas-report.ts';

const node = (id: string, attributes: Record<string, string> = {}) =>
	({ id, name: id.toUpperCase(), attributes, relationshipCount: 0 }) as unknown as WorkerGraphNode;

const link = (id: string, source: string, target: string) =>
	({ id, source, target, value: 1 }) as unknown as WorkerGraphLink;

const attribute = (id: string) => ({ id }) as unknown as WorkerAttributeDefinition;

const square = (): Point[] => [
	{ x: 0, y: 0 },
	{ x: 100, y: 0 },
	{ x: 100, y: 100 },
	{ x: 0, y: 100 }
];

function region(overrides: { key: string } & Partial<GroupRegion>): GroupRegion {
	return {
		label: overrides.key,
		hull: square(),
		path: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
		top: 0,
		labelX: 0,
		labelAt: { x: 0, y: 0, textAnchor: 'middle' },
		outlined: true,
		subRegions: [],
		...overrides
	};
}

const snapshot = (
	headings: ReadonlyMap<string, { width: number; height: number; baseline?: number }>
): TextSnapshot => ({ source: 'measured', revision: 'test', names: new Map(), headings });

const source = {
	visibleNodes: [] as WorkerGraphNode[],
	visibleLinks: [] as WorkerGraphLink[],
	positions: new Map<string, Point>(),
	routes: undefined,
	radiusFor: () => 5,
	placements: new Map(),
	regions: [] as GroupRegion[],
	textSnapshot: undefined,
	zoom: 1,
	groupingAttribute: undefined,
	subGroupingAttribute: undefined
};

describe('reportDrawingInput', () => {
	it('boxes a heading at its 11px face and a sub-heading at 10px, at the camera zoom', () => {
		const top = region({ key: 'alpha', labelAt: { x: 100, y: 200, textAnchor: 'middle' } });
		const sub = region({ key: 'alpha::one', labelAt: { x: 300, y: 400, textAnchor: 'start' } });
		const drawing = reportDrawingInput({
			...source,
			regions: [{ ...top, subRegions: [sub] }],
			textSnapshot: snapshot(
				new Map([
					['alpha', { width: 110, height: 22, baseline: 16 }],
					['alpha::one', { width: 100, height: 20, baseline: 14 }]
				])
			),
			zoom: 2
		});

		expect(drawing.headings.map((heading) => heading.id)).toEqual(['alpha', 'alpha::one']);
		const [topBox, subBox] = drawing.headings.map((heading) => heading.box);
		expect(topBox.left).toBeCloseTo(72.5);
		expect(topBox.top).toBeCloseTo(192);
		expect(topBox.right).toBeCloseTo(127.5);
		expect(topBox.bottom).toBeCloseTo(203);
		expect(subBox.left).toBeCloseTo(300);
		expect(subBox.top).toBeCloseTo(392.3);
		expect(subBox.right).toBeCloseTo(355);
		expect(subBox.bottom).toBeCloseTo(403.3);
	});

	it('boxes a heading from the label heuristic when the snapshot has no size for it', () => {
		const top = region({
			key: 'alpha',
			labelBox: { x: 10, y: 20, width: 80, height: 18 }
		});
		const drawing = reportDrawingInput({
			...source,
			regions: [{ ...top, subRegions: [] }],
			textSnapshot: snapshot(new Map())
		});

		expect(drawing.headings).toEqual([
			{ id: 'alpha', box: { left: 10, top: 20, right: 90, bottom: 38 } }
		]);
	});

	it('maps the drawn names, the shipped route paths and the drawn dots', () => {
		const drawing = reportDrawingInput({
			...source,
			visibleNodes: [node('a'), node('b')],
			visibleLinks: [link('ab', 'a', 'b'), link('ac', 'a', 'c')],
			positions: new Map([
				['a', { x: 1, y: 2 }],
				['b', { x: 3, y: 4 }],
				['c', { x: 5, y: 6 }]
			]),
			routes: new Map([['ab', { d: 'M 1 2 Q 2 3 3 4' }]]),
			radiusFor: (worker) => (worker.id === 'a' ? 7 : 8),
			placements: new Map([['a', { box: { left: 0, top: 10, right: 20, bottom: 26 } }]])
		});

		expect(drawing.routes).toEqual([
			{ id: 'ab', source: 'a', target: 'b', d: 'M 1 2 Q 2 3 3 4' },
			{ id: 'ac', source: 'a', target: 'c', d: 'M 1 2 L 5 6' }
		]);
		expect(drawing.dots).toEqual([
			{ id: 'a', x: 1, y: 2, r: 7 },
			{ id: 'b', x: 3, y: 4, r: 8 }
		]);
		expect(drawing.names).toEqual([
			{ id: 'name:a', worker: 'a', box: { left: 0, top: 10, right: 20, bottom: 26 } }
		]);
	});

	it('publishes only the outlined regions, each with its parent key', () => {
		const top = region({ key: 'alpha' });
		const outlined = region({ key: 'alpha::one' });
		const absent = region({ key: 'alpha::two', outlined: false });
		const drawing = reportDrawingInput({
			...source,
			regions: [{ ...top, subRegions: [outlined, absent] }],
			zoom: 2
		});

		expect(drawing.regions.map((entry) => entry.key)).toEqual(['alpha', 'alpha::one']);
		expect(drawing.regions[0].parent).toBeUndefined();
		expect(drawing.regions[1].parent).toBe('alpha');
		expect(drawing.regions.every((entry) => entry.outlined && entry.convex)).toBe(true);
		// The outline follows the drawn path, converted at the camera's map units.
		expect(boundsOf(drawing.regions[1].polygon)).toEqual({
			left: 0,
			top: 0,
			right: 100,
			bottom: 100
		});
	});

	it('places each Worker in its group and, when sub-grouped, its sub-group', () => {
		const department = attribute('dept');
		const role = attribute('role');
		const workers = [
			node('a', { dept: 'alpha', role: 'one' }),
			node('b', { dept: 'alpha', role: 'two' }),
			node('c')
		];

		const grouped = reportDrawingInput({
			...source,
			visibleNodes: workers,
			groupingAttribute: department
		});
		expect([...grouped.workerRegions]).toEqual([
			['a', ['alpha']],
			['b', ['alpha']],
			['c', ['__unassigned']]
		]);
		expect(grouped.unit).toBe(1);

		const nested = reportDrawingInput({
			...source,
			visibleNodes: workers.slice(0, 2),
			zoom: 4,
			groupingAttribute: department,
			subGroupingAttribute: role
		});
		expect([...nested.workerRegions]).toEqual([
			['a', ['alpha', 'alpha::one']],
			['b', ['alpha', 'alpha::two']]
		]);
		expect(nested.unit).toBe(0.25);
	});
});
