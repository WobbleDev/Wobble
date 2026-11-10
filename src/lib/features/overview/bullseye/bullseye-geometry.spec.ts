import { describe, expect, it } from 'vitest';
import type { AssessmentOption, Worker } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import {
	bandLayout,
	CHART_CENTER,
	DOT_FOOTPRINT,
	plotWorkerGroups,
	plotRelationshipTies,
	ringLabelWedge,
	tiePath,
	type BandLayout,
	type RingNames
} from './bullseye-geometry.ts';

/** The en ring names the chart passes: the group labels of each drawn standing. */
const EN_RING_NAMES: RingNames = {
	Leader: 'Leaders',
	Activist: 'Activists',
	Supporter: 'Supporters',
	Disengaged: 'Disengaged'
};

const plot = (workers: Worker[], bands: BandLayout[]) =>
	plotWorkerGroups(workers, bands, EN_RING_NAMES);

const worker = (id: string, assessment: Worker['assessment'], relationships: string[] = []) =>
	baseWorker({ id, name: id, assessment, relationships });

function counts(leader: number, activist: number, supporter: number, disengaged: number) {
	return { Leader: leader, Activist: activist, Supporter: supporter, Disengaged: disengaged };
}

const DRAWN_ASSESSMENTS = ['Leader', 'Activist', 'Supporter', 'Disengaged'] as const;

/** The packing lattice pitch: two dot footprints plus the minimum gap. */
const PITCH = 9;

function radiusOf(dot: { cx: number; cy: number }): number {
	return Math.hypot(dot.cx - CHART_CENTER, dot.cy - CHART_CENTER);
}

function pairwiseMin(dots: { cx: number; cy: number }[]): number {
	let min = Infinity;
	for (let i = 0; i < dots.length; i++) {
		for (let j = i + 1; j < dots.length; j++) {
			min = Math.min(min, Math.hypot(dots[i].cx - dots[j].cx, dots[i].cy - dots[j].cy));
		}
	}
	return min;
}

describe('bullseye-geometry', () => {
	it('grows each tree from a Committee member out to the Hostile track', () => {
		const workers = [
			worker('L1', 'Leader', ['L2', 'A1', 'H1']),
			worker('L2', 'Leader', ['L1']),
			worker('A1', 'Activist', ['L1', 'S1']),
			worker('S1', 'Supporter', ['A1', 'S2', 'D1']),
			worker('S2', 'Supporter', ['S1']),
			worker('D1', 'Disengaged', ['S1']),
			worker('H1', 'Hostile', ['L1'])
		];
		const groups = plot(workers, bandLayout(counts(2, 1, 2, 1)));
		const ties = plotRelationshipTies(workers, groups);
		expect(ties.map(({ id }) => id)).toEqual(['A1--S1', 'L1--A1', 'L1--H1', 'S1--D1', 'S1--S2']);
	});

	it('hangs a worker known by two members off just one of them', () => {
		const workers = [
			worker('L1', 'Leader', ['A1', 'A2']),
			worker('L2', 'Leader', ['A1']),
			worker('A1', 'Activist', ['L1', 'L2']),
			worker('A2', 'Activist', ['L1'])
		];
		const groups = plot(workers, bandLayout(counts(2, 2, 0, 0)));
		const ties = plotRelationshipTies(workers, groups);
		expect(ties.map(({ id }) => id)).toEqual(['L1--A1', 'L1--A2']);
	});

	it('never crosses two ties or runs one over a dot it does not join', () => {
		// A dense worksite with branching trees, including chains along the Supporter row.
		const workers: Worker[] = [];
		const add = (id: string, assessment: Worker['assessment']) => {
			workers.push(worker(id, assessment));
		};
		for (let i = 0; i < 6; i++) add(`L${i}`, 'Leader');
		for (let i = 0; i < 12; i++) add(`A${i}`, 'Activist');
		for (let i = 0; i < 16; i++) add(`S${i}`, 'Supporter');
		for (let i = 0; i < 8; i++) add(`D${i}`, 'Disengaged');
		const byId = new Map(workers.map((w) => [w.id, w]));
		const relate = (a: string, b: string) => {
			byId.get(a)!.relationships.push(b);
			byId.get(b)!.relationships.push(a);
		};
		for (let i = 0; i < 12; i++) relate(`A${i}`, `L${i % 6}`);
		for (let i = 0; i < 10; i++) relate(`S${i}`, `A${(i * 5) % 12}`);
		for (let i = 10; i < 16; i++) relate(`S${i}`, `S${i - 4}`);
		for (let i = 0; i < 8; i++) relate(`D${i}`, `S${i}`);
		const groups = plot(workers, bandLayout(counts(6, 12, 16, 8)));
		const ties = plotRelationshipTies(workers, groups);
		const dots = groups.flatMap((group) => group.dots);
		expect(ties).toHaveLength(36);

		const points = (d: string) => {
			const n = d.match(/-?[\d.]+/g)!.map(Number);
			if (!d.includes('Q')) return [n.slice(0, 2), n.slice(2, 4)];
			const [x0, y0, cx, cy, x1, y1] = n;
			return Array.from({ length: 41 }, (_, i) => {
				const t = i / 40;
				return [
					(1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1,
					(1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1
				];
			});
		};
		const turn = (p: number[], q: number[], r: number[]) =>
			Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
		const crosses = (a: number[][], b: number[][]) =>
			a
				.slice(1)
				.some((_, i) =>
					b
						.slice(1)
						.some(
							(_, j) =>
								turn(a[i], a[i + 1], b[j]) !== turn(a[i], a[i + 1], b[j + 1]) &&
								turn(b[j], b[j + 1], a[i]) !== turn(b[j], b[j + 1], a[i + 1])
						)
				);
		const paths = ties.map((tie) => points(tie.d));
		for (let i = 0; i < ties.length; i++) {
			for (let j = i + 1; j < ties.length; j++) {
				const ends = new Set([ties[i].from, ties[i].to]);
				if (ends.has(ties[j].from) || ends.has(ties[j].to)) continue;
				expect(crosses(paths[i], paths[j]), `${ties[i].id} × ${ties[j].id}`).toBe(false);
			}
			const along = paths[i]
				.slice(1)
				.flatMap((q, k) =>
					Array.from({ length: 11 }, (_, s) => [
						paths[i][k][0] + ((q[0] - paths[i][k][0]) * s) / 10,
						paths[i][k][1] + ((q[1] - paths[i][k][1]) * s) / 10
					])
				);
			for (const dot of dots) {
				if (dot.worker.id === ties[i].from || dot.worker.id === ties[i].to) continue;
				const nearest = Math.min(...along.map(([x, y]) => Math.hypot(x - dot.cx, y - dot.cy)));
				expect(nearest, `${ties[i].id} over ${dot.worker.id}`).toBeGreaterThan(DOT_FOOTPRINT);
			}
		}
	});

	it('draws a straight tie that stops short of both dots', () => {
		const d = tiePath({ cx: 128, cy: 30 }, { cx: 128, cy: 80 });
		const [y1, y2] = [...d.matchAll(/128 ([\d.]+)/g)].map((m) => Number(m[1]));
		expect(d).toMatch(/^M 128 [\d.]+ L 128 [\d.]+$/);
		expect(y1).toBeGreaterThan(30);
		expect(y2).toBeLessThan(80);
	});

	it('seats each worker beside its own Committee member, not across the chart', () => {
		const members = ['L1', 'L2', 'L3', 'L4'];
		const workers = [
			...members.map((id) => worker(id, 'Leader', [`${id}a`, `${id}b`])),
			...members.flatMap((id) => [
				worker(`${id}a`, 'Activist', [id]),
				worker(`${id}b`, 'Supporter', [id])
			])
		];
		const groups = plot(workers, bandLayout(counts(4, 4, 4, 0)));
		const dots = new Map(groups.flatMap((g) => g.dots.map((d) => [d.worker.id, d] as const)));
		const angle = (id: string) =>
			Math.atan2(dots.get(id)!.cy - CHART_CENTER, dots.get(id)!.cx - CHART_CENTER);
		for (const id of members) {
			for (const child of [`${id}a`, `${id}b`]) {
				const apart = Math.abs(
					Math.atan2(Math.sin(angle(child) - angle(id)), Math.cos(angle(child) - angle(id)))
				);
				expect(apart).toBeLessThan(Math.PI / 4);
			}
		}
	});

	it('never paints a band in the stop the panel itself is drawn on', () => {
		// The chart sits on `--page`, so the rings read the two stops either side
		// of it and nothing else. A band landing on `--page` would sink into the
		// panel in one theme and lift off it in the other, which is the grey haze
		// this ladder exists to replace.
		for (const tally of [counts(1, 1, 1, 1), counts(0, 0, 0, 0), counts(9, 1, 4, 2)]) {
			const fills = bandLayout(tally).map((band) => band.fill);
			expect(fills).toEqual(['var(--panel)', 'var(--inset)', 'var(--panel)', 'var(--inset)']);
			expect(fills).not.toContain('var(--page)');
		}
	});
});

describe('packing', () => {
	it('keeps a non-full single-member reach together around its target', () => {
		const workers = [
			worker('L1', 'Leader', ['A1', 'A2', 'A3', 'A4']),
			...Array.from({ length: 4 }, (_, index) => worker(`A${index + 1}`, 'Activist', ['L1']))
		];
		const dots = plot(workers, bandLayout(counts(1, 4, 0, 0))).find(
			(group) => group.assessment === 'Activist'
		)!.dots;
		expect(pairwiseMin(dots)).toBeGreaterThanOrEqual(PITCH - 1e-6);
		for (const dot of dots) {
			const angle = Math.atan2(dot.cy - CHART_CENTER, dot.cx - CHART_CENTER);
			expect(
				Math.abs(Math.atan2(Math.sin(angle + Math.PI / 2), Math.cos(angle + Math.PI / 2)))
			).toBeLessThanOrEqual(Math.PI / 4);
		}
	});

	it('fills the innermost rows with tied workers before untied workers', () => {
		const workers = [
			worker(
				'L1',
				'Leader',
				Array.from({ length: 32 }, (_, i) => `A${i}`)
			),
			...Array.from({ length: 32 }, (_, i) => worker(`A${i}`, 'Activist', i < 4 ? ['L1'] : []))
		];
		const bands = bandLayout(counts(1, 32, 0, 0));
		const activistBand = bands.find((band) => band.assessment === 'Activist')!;
		const dots = plot(workers, bands).find((group) => group.assessment === 'Activist')!.dots;
		const tiedRadii = dots
			.filter((dot) => dot.worker.relationships.length > 0)
			.map((dot) => radiusOf(dot));
		const untiedRadii = dots
			.filter((dot) => dot.worker.relationships.length === 0)
			.map((dot) => radiusOf(dot));
		expect(Math.max(...tiedRadii)).toBeLessThanOrEqual(Math.min(...untiedRadii) + 1e-6);
		expect(Math.min(...tiedRadii)).toBeGreaterThan(activistBand.innerRadius);
	});

	it('keeps every dot at least one pitch from every other, in any band, for 1–50 workers', () => {
		for (const assessment of DRAWN_ASSESSMENTS) {
			for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50]) {
				const workers = Array.from({ length: n }, (_, index) =>
					worker(`${assessment}${index}`, assessment)
				);
				const countsByBand: Partial<Record<AssessmentOption, number>> = {
					[assessment]: n
				};
				const dots = plot(workers, bandLayout(countsByBand)).flatMap((group) => group.dots);
				expect(dots).toHaveLength(n);
				expect(pairwiseMin(dots)).toBeGreaterThanOrEqual(PITCH - 1e-6);
			}
		}
	});

	it('keeps the pitch across neighbouring bands when two bands are crowded', () => {
		const workers = [
			...Array.from({ length: 25 }, (_, index) => worker(`L${index}`, 'Leader')),
			...Array.from({ length: 25 }, (_, index) => worker(`A${index}`, 'Activist'))
		];
		const dots = plot(workers, bandLayout(counts(25, 25, 0, 0))).flatMap((group) => group.dots);
		expect(dots).toHaveLength(50);
		expect(pairwiseMin(dots)).toBeGreaterThanOrEqual(PITCH - 1e-6);
	});

	it('keeps the pitch for mixed distributions across the 50-worker envelope', () => {
		const distributions = [
			{ Leader: 20, Activist: 30, Supporter: 0, Disengaged: 0 },
			{ Leader: 10, Activist: 40, Supporter: 0, Disengaged: 0 },
			{ Leader: 13, Activist: 12, Supporter: 13, Disengaged: 12 },
			{ Leader: 25, Activist: 25, Supporter: 0, Disengaged: 0 }
		];

		for (const distribution of distributions) {
			const workers = DRAWN_ASSESSMENTS.flatMap((assessment) =>
				Array.from({ length: distribution[assessment] }, (_, index) =>
					worker(`${assessment}${index}`, assessment)
				)
			);
			const dots = plot(workers, bandLayout(distribution)).flatMap((group) => group.dots);
			expect(dots).toHaveLength(50);
			expect(pairwiseMin(dots)).toBeGreaterThanOrEqual(PITCH - 1e-6);
		}
	});

	it('keeps every dot inside its band', () => {
		for (const assessment of DRAWN_ASSESSMENTS) {
			const n = 30;
			const workers = Array.from({ length: n }, (_, index) =>
				worker(`${assessment}${index}`, assessment)
			);
			const bands = bandLayout({ [assessment]: n });
			const band = bands.find((candidate) => candidate.assessment === assessment)!;
			const dots = plot(workers, bands).find((group) => group.assessment === assessment)!.dots;

			expect(dots).toHaveLength(n);
			for (const dot of dots) {
				const radius = radiusOf(dot);
				expect(radius).toBeGreaterThanOrEqual(band.innerRadius - 1e-6);
				expect(radius).toBeLessThanOrEqual(band.outerRadius + 1e-6);
			}
		}
	});

	it('keeps a sparse band on a single centreline row', () => {
		const workers = [
			worker('L1', 'Leader'),
			worker('A1', 'Activist'),
			worker('A2', 'Activist'),
			worker('A3', 'Activist'),
			worker('S1', 'Supporter'),
			worker('D1', 'Disengaged')
		];
		const bands = bandLayout(counts(1, 3, 1, 1));
		const activistBand = bands.find((band) => band.assessment === 'Activist')!;
		const activistDots = plot(workers, bands).find(
			(group) => group.assessment === 'Activist'
		)!.dots;

		expect(activistDots).toHaveLength(3);
		for (const dot of activistDots) {
			expect(radiusOf(dot)).toBeCloseTo(activistBand.centerlineRadius);
		}
	});

	it('orders each band so workers related to the same Committee member sit together', () => {
		const workers = [
			worker('L2', 'Leader'),
			worker('L1', 'Leader'),
			worker('S-d', 'Supporter'),
			worker('S-b', 'Supporter', ['L1']),
			worker('S-c', 'Supporter', ['L2']),
			worker('S-a', 'Supporter', ['L1'])
		];
		const bands = bandLayout(counts(2, 0, 4, 0));
		const supporterOrder = plot(workers, bands)
			.find((group) => group.assessment === 'Supporter')!
			.dots.map((dot) => dot.worker.id);

		expect(supporterOrder).toEqual(['S-a', 'S-b', 'S-c', 'S-d']);
	});

	it('keeps Hostile dots on their outer track at the pitch for up to 50 workers', () => {
		const workers = Array.from({ length: 50 }, (_, index) => worker(`H${index}`, 'Hostile'));
		const dots = plot(workers, bandLayout(counts(0, 0, 0, 0))).find(
			(group) => group.assessment === 'Hostile'
		)!.dots;

		expect(dots).toHaveLength(50);
		expect(pairwiseMin(dots)).toBeGreaterThanOrEqual(PITCH - 1e-6);
		for (const dot of dots) {
			expect(radiusOf(dot)).toBeCloseTo(108);
		}
	});
});

describe('ring names', () => {
	/* The anchor is -44° clockwise from twelve o'clock, in the chart's own angle convention. */
	const ANCHOR = (-44 * Math.PI) / 180 - Math.PI / 2;
	const angleOf = (dot: { cx: number; cy: number }) =>
		Math.atan2(dot.cy - CHART_CENTER, dot.cx - CHART_CENTER);
	const offsetFromAnchor = (dot: { cx: number; cy: number }) => {
		const delta = angleOf(dot) - ANCHOR;
		return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
	};

	it('keeps a wedge that grows with the name and shrinks with the radius', () => {
		expect(ringLabelWedge('Disengaged', 60)).toBeGreaterThan(ringLabelWedge('Activists', 60));
		expect(ringLabelWedge('Activists', 60)).toBeGreaterThan(ringLabelWedge('Leaders', 60));
		expect(ringLabelWedge('Activists', 90)).toBeLessThan(ringLabelWedge('Activists', 60));
	});

	it('caps the wedge at a quarter turn for a band too thin to hold its name', () => {
		expect(ringLabelWedge('Disengaged', 1)).toBe(Math.PI / 2);
	});

	it('keeps every named band dot outside the wedge its name needs', () => {
		const tally = counts(6, 12, 16, 8);
		const workers = DRAWN_ASSESSMENTS.flatMap((assessment) =>
			Array.from({ length: tally[assessment] }, (_, index) =>
				worker(`${assessment}${index}`, assessment)
			)
		);
		const bands = bandLayout(tally);
		const groups = plot(workers, bands);
		for (const band of bands) {
			if (band.assessment === 'Leader') continue;
			const wedge = ringLabelWedge(EN_RING_NAMES[band.assessment], band.centerlineRadius);
			const dots = groups.find((group) => group.assessment === band.assessment)!.dots;
			for (const dot of dots) {
				expect(offsetFromAnchor(dot), `${band.assessment} ${dot.worker.id}`).toBeGreaterThanOrEqual(
					wedge / 2 - 1e-6
				);
			}
		}
	});

	it('keeps the Leader band on the whole circle', () => {
		const leaders = Array.from({ length: 4 }, (_, index) => worker(`L${index}`, 'Leader'));
		const dots = plot(leaders, bandLayout(counts(4, 0, 0, 0))).find(
			(group) => group.assessment === 'Leader'
		)!.dots;
		const angles = dots.map(angleOf).sort((a, b) => a - b);
		const gaps = angles.map((angle, index) =>
			index + 1 < angles.length ? angles[index + 1] - angle : angles[0] + Math.PI * 2 - angle
		);
		for (const gap of gaps) expect(gap).toBeCloseTo(Math.PI / 2, 6);
	});

	it("moves a dot whose natural angle falls in the wedge to the edge on its member's side", () => {
		const members = ['L1', 'L2', 'L3', 'L4'];
		const workers = [
			...members.map((id) => worker(id, 'Leader', [`${id}a`, `${id}b`])),
			...members.flatMap((id) => [
				worker(`${id}a`, 'Activist', [id]),
				worker(`${id}b`, 'Supporter', [id])
			])
		];
		const bands = bandLayout(counts(4, 4, 4, 0));
		const dots = new Map(
			plot(workers, bands).flatMap((group) =>
				group.dots.map((dot) => [dot.worker.id, dot] as const)
			)
		);
		const wedge = ringLabelWedge(
			EN_RING_NAMES.Activist,
			bands.find((band) => band.assessment === 'Activist')!.centerlineRadius
		);
		const anchor = (-44 * Math.PI) / 180 - Math.PI / 2;
		const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
		const offset = (id: string) => wrap(angleOf(dots.get(id)!) - anchor);
		let onEdge = 0;
		for (const id of members) {
			const child = `${id}a`;
			const o = offset(child);
			if (Math.abs(Math.abs(o) - wedge / 2) > 1e-6) continue;
			onEdge++;
			// The wedge edge nearer the member is the one the child lands on.
			const toHigh = Math.abs(wrap(offset(id) - wedge / 2));
			const toLow = Math.abs(wrap(offset(id) + wedge / 2));
			expect(o > 0, `${child} side`).toBe(toHigh <= toLow);
		}
		expect(onEdge).toBeGreaterThan(0);
	});

	it('plots every band with one dot per worker', () => {
		const tally = counts(6, 12, 16, 8);
		const workers = DRAWN_ASSESSMENTS.flatMap((assessment) =>
			Array.from({ length: tally[assessment] }, (_, index) =>
				worker(`${assessment}${index}`, assessment)
			)
		);
		const groups = plot(workers, bandLayout(tally));
		for (const assessment of DRAWN_ASSESSMENTS) {
			expect(groups.find((group) => group.assessment === assessment)!.dots).toHaveLength(
				tally[assessment]
			);
		}
	});
});
