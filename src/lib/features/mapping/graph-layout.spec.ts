// @module-tag mapping
import { describe, expect, it } from 'vitest';
import {
	centroidOf,
	convexHull,
	dilateHull,
	layoutGroupRegions,
	padHull,
	regionsExtent,
	type GroupRegion,
	type PlacedWorker,
	type Point,
	type RegionGroup
} from './graph-layout.ts';

/** True when a point sits inside a convex polygon, whichever way round it is wound. */
function inside(polygon: readonly Point[], point: Point): boolean {
	const signs = polygon.map((vertex, index) => {
		const next = polygon[(index + 1) % polygon.length];
		const cross =
			(next.x - vertex.x) * (point.y - vertex.y) - (next.y - vertex.y) * (point.x - vertex.x);
		return Math.sign(cross);
	});

	return signs.every((sign) => sign >= 0) || signs.every((sign) => sign <= 0);
}

describe('padHull', () => {
	const groupPadding = 52;
	const subGroupPadding = 26;

	function expectContained(parent: readonly Point[], child: readonly Point[], centre: Point) {
		const groupHull = padHull(convexHull(parent), groupPadding, centre);
		const subGroupHull = padHull(convexHull(child), subGroupPadding, centre);

		for (const point of subGroupHull) {
			expect(inside(groupHull, point)).toBe(true);
		}
	}

	it('keeps a sub-group inside its group when the sub-group sits in a corner', () => {
		const members = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
			{ x: 0, y: 100 }
		];
		const centre = { x: 50, y: 50 };

		expectContained(
			members,
			[
				{ x: 90, y: 90 },
				{ x: 100, y: 100 }
			],
			centre
		);
	});

	it('keeps a sub-group inside its group when the sub-group hugs the centre', () => {
		const members = [
			{ x: 0, y: 0 },
			{ x: 200, y: 0 },
			{ x: 200, y: 200 },
			{ x: 0, y: 200 }
		];
		const centre = { x: 100, y: 100 };

		expectContained(
			members,
			[
				{ x: 90, y: 90 },
				{ x: 110, y: 100 },
				{ x: 95, y: 120 }
			],
			centre
		);
	});

	it('keeps a lone worker inside its group', () => {
		const members = [
			{ x: 0, y: 0 },
			{ x: 200, y: 0 },
			{ x: 200, y: 200 },
			{ x: 0, y: 200 }
		];
		const centre = { x: 100, y: 100 };
		const groupHull = padHull(convexHull(members), groupPadding, centre);
		const [lone] = padHull(
			[
				{ x: 190, y: 10 },
				{ x: 200, y: 20 },
				{ x: 180, y: 20 }
			],
			subGroupPadding,
			centre
		);

		expect(inside(groupHull, lone)).toBe(true);
	});

	it('pushes every vertex away from the origin it is given', () => {
		const hull = [
			{ x: 10, y: 0 },
			{ x: 20, y: 0 },
			{ x: 20, y: 10 }
		];
		const origin = { x: 1000, y: 1000 };

		// The origin sits down and to the right, so every vertex moves up and to the left.
		const [first] = padHull(hull, 10, origin);
		expect(first.x).toBeLessThan(hull[0].x);
		expect(first.y).toBeLessThan(hull[0].y);
		expect(Math.hypot(first.x - origin.x, first.y - origin.y)).toBeCloseTo(
			Math.hypot(hull[0].x - origin.x, hull[0].y - origin.y) + 10
		);
	});
});

describe('centroidOf', () => {
	it('is the middle of the points it is given', () => {
		expect(
			centroidOf([
				{ x: -10, y: -10 },
				{ x: 10, y: -10 },
				{ x: 10, y: 10 },
				{ x: -10, y: 10 }
			])
		).toEqual({ x: 0, y: 0 });
	});

	it('is the origin when there is nothing to average', () => {
		expect(centroidOf([])).toEqual({ x: 0, y: 0 });
	});
});

describe('dilateHull', () => {
	it('contains every point it was given', () => {
		const points = [
			{ x: 0, y: 0 },
			{ x: 120, y: 4 },
			{ x: 60, y: 6 }
		];

		const grown = dilateHull(points, 20);

		for (const point of points) {
			expect(inside(grown, point)).toBe(true);
		}
	});

	it('grows a single point into a region with area', () => {
		const grown = dilateHull([{ x: 5, y: 5 }], 14);

		const width =
			Math.max(...grown.map((point) => point.x)) - Math.min(...grown.map((point) => point.x));
		const height =
			Math.max(...grown.map((point) => point.y)) - Math.min(...grown.map((point) => point.y));

		expect(Math.min(width, height)).toBeCloseTo(28, 0);
	});

	it('leaves a shape alone when asked to grow by nothing', () => {
		const points = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 0, y: 10 }
		];

		expect(dilateHull(points, 0)).toEqual(points);
	});
});

describe('regionsExtent', () => {
	const region = (key: string, hull: Point[], labelAt: Point): GroupRegion => ({
		key,
		label: key,
		hull,
		labelAt: { ...labelAt, textAnchor: 'middle' as const },
		path: '',
		top: 0,
		labelX: 0,
		outlined: true,
		subRegions: []
	});

	it('covers a label drawn above its hull', () => {
		expect(
			regionsExtent(
				[
					region(
						'a',
						[
							{ x: 2, y: 20 },
							{ x: 10, y: 30 }
						],
						{ x: 6, y: 8 }
					)
				],
				15
			)
		).toEqual({
			x: 2,
			y: -7,
			width: 8,
			height: 37
		});
	});

	it('covers sub-region labels', () => {
		const parent = region('a', [{ x: 0, y: 0 }], { x: 0, y: 1 });
		parent.subRegions = [region('a::b', [{ x: 8, y: 18 }], { x: 80, y: -20 })];
		expect(regionsExtent([parent], 15)).toEqual({ x: 0, y: -35, width: 80, height: 53 });
	});

	it('returns undefined with no regions', () => {
		expect(regionsExtent([], 15)).toBeUndefined();
	});
});

describe('a group region built around its sub-groups', () => {
	const subGroupPadding = 26;
	const groupPadding = 14;

	function groupRegion(children: readonly (readonly Point[])[]) {
		const centre = { x: 0, y: 0 };
		const childHulls = children.map((members) =>
			padHull(convexHull(members), subGroupPadding, centre)
		);
		const groupHull = dilateHull(convexHull(childHulls.flat()), groupPadding);

		return { childHulls, groupHull };
	}

	it('holds a sub-group that hugs one edge of a group strung out in a line', () => {
		const { childHulls, groupHull } = groupRegion([
			[
				{ x: 0, y: 0 },
				{ x: 90, y: 0 }
			],
			[
				{ x: 180, y: 0 },
				{ x: 180, y: 40 }
			]
		]);

		for (const childHull of childHulls) {
			for (const point of childHull) {
				expect(inside(groupHull, point)).toBe(true);
			}
		}
	});

	it('holds a sub-group perched on a corner of the group', () => {
		const { childHulls, groupHull } = groupRegion([
			[
				{ x: 90, y: 90 },
				{ x: 100, y: 100 }
			],
			[
				{ x: 0, y: 0 },
				{ x: 0, y: 100 },
				{ x: 100, y: 0 }
			]
		]);

		for (const childHull of childHulls) {
			for (const point of childHull) {
				expect(inside(groupHull, point)).toBe(true);
			}
		}
	});

	it('leaves room around a group that holds a single sub-group', () => {
		const members = [
			{ x: 0, y: 0 },
			{ x: 60, y: 0 },
			{ x: 30, y: 40 }
		];
		const { childHulls, groupHull } = groupRegion([members]);

		for (const point of childHulls[0]) {
			expect(inside(groupHull, point)).toBe(true);
		}
		// Not merely coincident: the group outline clears its only sub-group.
		expect(groupHull.length).toBeGreaterThan(childHulls[0].length);
	});
});

describe('layoutGroupRegions', () => {
	const regionGroups: RegionGroup[] = [
		{
			value: 'Front of House',
			label: 'Front of House',
			subGroups: [
				{ value: 'Server', label: 'Server' },
				{ value: 'Cook', label: 'Cook' }
			]
		},
		{ value: '', label: 'No Department', subGroups: [{ value: '', label: 'No Role' }] }
	];

	/** Four workers per sub-group, spread around a point well off the group's own centre. */
	function workers(): PlacedWorker[] {
		const placed: PlacedWorker[] = [];
		const clusters = [
			{ group: 'Front of House', subGroup: 'Server', x: 90, y: 90 },
			{ group: 'Front of House', subGroup: 'Cook', x: 90, y: -90 },
			{ group: '', subGroup: '', x: -120, y: 0 }
		];

		for (const cluster of clusters) {
			for (let step = 0; step < 4; step += 1) {
				const angle = (step / 4) * Math.PI * 2;
				placed.push({
					group: cluster.group,
					subGroup: cluster.subGroup,
					x: cluster.x + Math.cos(angle) * 20,
					y: cluster.y + Math.sin(angle) * 20
				});
			}
		}

		return placed;
	}

	it('contracts to a subset of workers and omits a group with none', () => {
		const all = workers();
		const subset = all
			.filter((worker) => worker.group === 'Front of House')
			.filter((worker) => worker.subGroup === 'Server');
		const regions = layoutGroupRegions(regionGroups, subset);

		expect(regions.map((region) => region.label)).toEqual(['Front of House']);
		const full = layoutGroupRegions(regionGroups, all).find(
			(region) => region.label === 'Front of House'
		);
		const ys = (hull: readonly { y: number }[]) => hull.map((point) => point.y);
		const span = (hull: readonly { y: number }[]) => Math.max(...ys(hull)) - Math.min(...ys(hull));
		expect(span(regions[0].hull)).toBeLessThan(span(full?.hull ?? []));
	});

	it('encloses every worker in the region of its own sub-group', () => {
		const regions = layoutGroupRegions(
			regionGroups.filter((group) => group.value !== ''),
			workers().filter((worker) => worker.group !== '')
		);

		for (const region of regions) {
			for (const subRegion of region.subRegions) {
				const members = workers().filter(
					(worker) => worker.group === region.label && worker.subGroup === subRegion.label
				);
				expect(members.length).toBeGreaterThan(0);
				for (const member of members) {
					expect(inside(subRegion.hull, member)).toBe(true);
				}
			}
		}
	});

	it('encloses every worker in the region of its own group', () => {
		for (const region of layoutGroupRegions(regionGroups, workers())) {
			const members = workers().filter((worker) => worker.group === region.label);
			for (const member of members) {
				expect(inside(region.hull, member)).toBe(true);
			}
		}
	});

	it('holds every sub-region inside its group region', () => {
		for (const region of layoutGroupRegions(regionGroups, workers())) {
			for (const subRegion of region.subRegions) {
				for (const point of subRegion.hull) {
					expect(inside(region.hull, point)).toBe(true);
				}
			}
		}
	});

	it('names a bucket for an absent answer and leaves it unoutlined', () => {
		const regions = layoutGroupRegions(regionGroups, workers());
		const unassigned = regions.find((region) => region.label === 'No Department');
		const noRole = unassigned?.subRegions[0];

		expect(unassigned?.outlined).toBe(false);
		expect(noRole?.label).toBe('No Role');
		expect(noRole?.outlined).toBe(false);
	});

	it('anchors a sub-region label outside its own outline, clear of the group label', () => {
		const regions = layoutGroupRegions(regionGroups, workers());
		for (const region of regions) {
			const labelBoxTop = region.labelAt.y - 12;
			for (const sub of region.subRegions) {
				const { x, y, textAnchor } = sub.labelAt;
				expect(['start', 'middle', 'end']).toContain(textAnchor);
				// The anchor point itself is never inside the sub-region's outline.
				expect(inside(sub.hull, { x, y })).toBe(false);
				// Group label sits above (never inside the band of) the sub label.
				expect(Math.abs(region.labelAt.y - y) > 10 || Math.abs(region.labelAt.x - x) > 40).toBe(
					true
				);
			}
			expect(labelBoxTop).toBeLessThan(region.top);
		}
	});

	it('keys a sub-region by both levels', () => {
		const front = layoutGroupRegions(regionGroups, workers()).find(
			(region) => region.label === 'Front of House'
		);

		expect(front?.key).toBe('Front of House');
		expect(front?.subRegions.map((subRegion) => subRegion.key)).toEqual([
			'Front of House::Server',
			'Front of House::Cook'
		]);
	});

	it('draws a group with no sub-groups flat', () => {
		const flat: RegionGroup[] = [
			{ value: 'Front of House', label: 'Front of House', subGroups: [] }
		];
		const [region] = layoutGroupRegions(flat, workers());
		const members = workers().filter((worker) => worker.group === 'Front of House');

		expect(region.subRegions).toEqual([]);
		for (const member of members) {
			expect(inside(region.hull, member)).toBe(true);
		}
	});

	it('gives two workers strung out in a line a region with area', () => {
		const flat: RegionGroup[] = [{ value: 'Back of House', label: 'Back of House', subGroups: [] }];
		const [region] = layoutGroupRegions(flat, [
			{ group: 'Back of House', subGroup: '', x: 0, y: 0 },
			{ group: 'Back of House', subGroup: '', x: 120, y: 0 }
		]);

		const width =
			Math.max(...region.hull.map((point) => point.x)) -
			Math.min(...region.hull.map((point) => point.x));
		const height =
			Math.max(...region.hull.map((point) => point.y)) -
			Math.min(...region.hull.map((point) => point.y));

		expect(height).toBeGreaterThan(20);
		expect(width).toBeGreaterThan(120);
	});

	it('draws far-apart members as one closed outline that holds every member', () => {
		const flat: RegionGroup[] = [{ value: 'Back of House', label: 'Back of House', subGroups: [] }];
		const points = [
			{ x: 0, y: 0 },
			{ x: 30, y: 0 },
			{ x: 500, y: 40 }
		];
		const [region] = layoutGroupRegions(
			flat,
			points.map((point) => ({ ...point, group: 'Back of House', subGroup: '' }))
		);

		expect(region.path.match(/M/g)).toHaveLength(1);
		expect(region.path.trim().endsWith('Z')).toBe(true);
		expect('islands' in region).toBe(false);
		expect('islandPath' in region).toBe(false);
		for (const point of points) expect(inside(region.hull, point)).toBe(true);
	});

	it('gives a lone member and a collinear set a non-degenerate outline', () => {
		const flat: RegionGroup[] = [{ value: 'Back of House', label: 'Back of House', subGroups: [] }];
		const place = (xs: number[]) =>
			xs.map((x) => ({ x, y: 0, group: 'Back of House', subGroup: '' }));
		for (const xs of [[0], [0, 100, 200]]) {
			const [region] = layoutGroupRegions(flat, place(xs));
			const ys = region.hull.map((point) => point.y);
			expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(40);
			expect(region.path.match(/M/g)).toHaveLength(1);
		}
	});

	it('gives each sub-region one outline', () => {
		const groups: RegionGroup[] = [
			{
				value: 'A',
				label: 'A',
				subGroups: [
					{ value: 'x', label: 'x' },
					{ value: 'y', label: 'y' }
				]
			}
		];
		const [region] = layoutGroupRegions(groups, [
			{ x: 0, y: 0, group: 'A', subGroup: 'x' },
			{ x: 400, y: 0, group: 'A', subGroup: 'x' },
			{ x: 0, y: 300, group: 'A', subGroup: 'y' }
		]);

		expect(region.subRegions).toHaveLength(2);
		for (const sub of region.subRegions) expect(sub.path.match(/M/g)).toHaveLength(1);
	});

	it('keeps every member at least the padding from its region hull', () => {
		const distanceToEdges = (hull: readonly Point[], p: Point) =>
			Math.min(
				...hull.map((a, index) => {
					const b = hull[(index + 1) % hull.length];
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const t = Math.max(
						0,
						Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1))
					);
					return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
				})
			);

		for (const region of layoutGroupRegions(regionGroups, workers())) {
			for (const member of workers().filter((worker) => worker.group === region.label)) {
				expect(distanceToEdges(region.hull, member)).toBeGreaterThanOrEqual(44 - 0.001);
			}
		}
	});

	it('curves region outlines with cubic segments and no straight edges', () => {
		for (const region of layoutGroupRegions(regionGroups, workers())) {
			for (const outline of [region, ...region.subRegions]) {
				expect(outline.path).toContain('C');
				expect(outline.path).not.toContain('L');
			}
		}
	});

	it('closes the outline of a one- or two-member group', () => {
		const flat: RegionGroup[] = [{ value: 'Back of House', label: 'Back of House', subGroups: [] }];
		for (const xs of [[0], [0, 120]]) {
			const [region] = layoutGroupRegions(
				flat,
				xs.map((x) => ({ x, y: 0, group: 'Back of House', subGroup: '' }))
			);
			expect(region.path.trim().startsWith('M')).toBe(true);
			expect(region.path.trim().endsWith('Z')).toBe(true);
		}
	});
});
