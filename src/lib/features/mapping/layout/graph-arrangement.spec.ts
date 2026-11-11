// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { layoutGroupRegions } from './graph-layout.ts';
import {
	createArranger,
	arrange,
	localLayoutSolves,
	type ArrangeInput
} from './graph-arrangement.ts';
import type { ManualGeometry } from './graph-manual.ts';
import { separationPairChecks, stressPairVisits } from './graph-stress.ts';
import { nodeRadius } from '../map-style.ts';
import {
	createLayoutQualityFixture,
	qualityArrangeInput
} from '#lib/testing/mapping/graph-layout-quality-fixture.ts';
import {
	answerIdOf,
	answerIdsFixture,
	answerText,
	attributeFixture
} from '#lib/testing/mapping/answer-fixtures.ts';
import type { WorkerGraphLink, WorkerGraphNode } from '../canvas/worker-relationship-map-model.ts';

const department = attributeFixture({
	id: 'dept',
	name: 'Department',
	kind: 'category',
	options: [
		'Front',
		'Back',
		'Bar',
		'Host',
		'A',
		'B',
		'C',
		'D',
		'E',
		'F',
		'Parent',
		'Inside',
		'Outside',
		'Z'
	]
});

/** The id a Department answer is held under, for keying the layout's centres by text. */
const dk = (text: string) => (text === '' ? '' : answerIdOf('dept', text));

function node(id: string, departmentValue: string, relationshipCount = 1): WorkerGraphNode {
	return {
		id,
		name: id,
		assessment: 'Unassessed',
		attributes: answerIdsFixture({ dept: departmentValue }),
		relationshipCount
	};
}

function link(id: string, source: string, target: string): WorkerGraphLink {
	return { id, source, target, value: 1 };
}

function input(overrides: Partial<ArrangeInput> & Pick<ArrangeInput, 'mode' | 'nodes' | 'links'>) {
	return {
		groupingAttribute: undefined,
		canvas: { width: 800, height: 600 },
		gap: 80,
		...overrides
	} satisfies ArrangeInput;
}

describe('arrange', () => {
	it('lays every ungrouped Worker out and draws no cross-group tie', () => {
		const nodes = [node('a', '', 0), node('b', '', 2), node('c', '', 1)];
		const links = [link('l1', 'a', 'b'), link('l2', 'b', 'c')];

		const result = arrange(input({ mode: 'free', nodes, links }));

		expect(result.positions.size).toBe(3);
		for (const point of result.positions.values()) {
			expect(Number.isFinite(point.x)).toBe(true);
			expect(Number.isFinite(point.y)).toBe(true);
		}
		expect(result.crossLinkIds.size).toBe(0);
		// The resting extent bounds every drawn Worker.
		for (const { x, y } of result.positions.values()) {
			expect(x).toBeGreaterThanOrEqual(result.min.x);
			expect(x).toBeLessThanOrEqual(result.max.x);
			expect(y).toBeGreaterThanOrEqual(result.min.y);
			expect(y).toBeLessThanOrEqual(result.max.y);
		}
	});

	it('reaches the same arrangement for the same geometry, and a new one when it changes', () => {
		const nodes = [node('a', 'Front'), node('b', 'Front'), node('c', 'Back')];
		const links = [link('l1', 'a', 'b'), link('l2', 'a', 'c')];
		const grouped = input({
			mode: 'grouped',
			nodes,
			links,
			groupingAttribute: department
		});

		// Memoized: hover, selection and label changes never move the geometry.
		expect(arrange(grouped)).toBe(arrange(grouped));
		expect(arrange({ ...grouped, canvas: { width: 900, height: 600 } })).not.toBe(arrange(grouped));
	});

	it('re-arranges when a Worker changes its Grouping answer and restores positions on Undo', () => {
		const nodes = [node('a', 'Front'), node('b', 'Front'), node('c', 'Back')];
		const grouped = input({
			mode: 'grouped',
			nodes,
			links: [link('relationship', 'a', 'b')],
			groupingAttribute: department
		});
		const before = arrange(grouped);
		const after = arrange({
			...grouped,
			nodes: nodes.map((worker) =>
				worker.id === 'b' ? { ...worker, attributes: answerIdsFixture({ dept: 'Back' }) } : worker
			)
		});

		expect(before.crossLinkIds.has('relationship')).toBe(false);
		expect(after).not.toBe(before);
		expect(after.crossLinkIds.has('relationship')).toBe(true);
		expect(after.positions.get('b')).not.toEqual(before.positions.get('b'));
		expect([...after.centres.keys()]).toEqual([dk('Front'), dk('Back')]);
		expect(arrange(grouped).positions).toEqual(before.positions);
	});

	it('moves a Worker into Unanswered when cleared and out when given an answer', () => {
		const grouped = input({
			mode: 'grouped',
			nodes: [node('a', 'Front'), node('b', 'Back')],
			links: [link('relationship', 'a', 'b')],
			groupingAttribute: department
		});
		const before = arrange(grouped);
		const cleared = arrange({ ...grouped, nodes: [node('a', 'Front'), node('b', '')] });
		expect(cleared).not.toBe(before);
		expect([...cleared.centres.keys()]).toEqual([dk('Front'), dk('')]);
		expect(cleared.positions.size).toBe(2);
		expect(cleared.crossLinkIds.has('relationship')).toBe(true);

		const answered = arrange({ ...grouped, nodes: [node('a', 'Front'), node('b', 'Front')] });
		expect([...answered.centres.keys()]).toEqual([dk('Front')]);
		expect(answered.positions.size).toBe(2);
		expect(answered.crossLinkIds.size).toBe(0);
	});

	it('identifies missing and non-text Grouping answers as the same Unanswered membership', () => {
		const grouped = input({
			mode: 'grouped',
			nodes: [node('a', 'Front'), { ...node('b', ''), attributes: {} }],
			links: [],
			groupingAttribute: department
		});
		const before = arrange(grouped);
		const nonText = arrange({
			...grouped,
			nodes: [
				node('a', 'Front'),
				{ ...node('b', ''), attributes: answerIdsFixture({ dept: ['Back'] }) }
			]
		});
		expect(nonText).toBe(before);
		expect([...nonText.centres.keys()]).toEqual([dk('Front'), dk('')]);
	});

	it('invalidates a Sub-grouping answer edit', () => {
		const shift = attributeFixture({
			id: 'shift',
			name: 'Shift',
			kind: 'category',
			options: ['Day', 'Night']
		});
		const grouped = input({
			mode: 'grouped',
			nodes: [
				{
					...node('a', 'Front'),
					attributes: answerIdsFixture({ dept: 'Front', shift: 'Day' })
				},
				{
					...node('b', 'Back'),
					attributes: answerIdsFixture({ dept: 'Back', shift: 'Day' })
				}
			],
			links: [link('relationship', 'a', 'b')],
			groupingAttribute: department,
			subGroupingAttribute: shift
		});
		const before = arrange(grouped);
		const after = arrange({
			...grouped,
			nodes: grouped.nodes.map((worker) =>
				worker.id === 'b'
					? { ...worker, attributes: answerIdsFixture({ dept: 'Back', shift: 'Night' }) }
					: worker
			)
		});
		// A changed answer is a changed geometry: the sub-bodies are packed afresh.
		expect(after).not.toBe(before);
		expect(after.crossLinkIds).toEqual(before.crossLinkIds);
	});

	it('rebuilds the grouped Arrangement when the order of the held answers changes', () => {
		// The layout orders groups by the answers' list positions, so a reorder is a new layout.
		const grouped = input({
			mode: 'grouped',
			nodes: [node('a', 'Front'), node('b', 'Back')],
			links: [link('relationship', 'a', 'b')],
			groupingAttribute: department
		});
		const before = arrange(grouped);
		const after = arrange({
			...grouped,
			groupingAttribute: {
				...department,
				answers: [...department.answers].reverse()
			}
		});
		expect(after).not.toBe(before);
	});

	it.each(['other Category', 'name', 'Assessment', 'Category options'])(
		'reuses the grouped Arrangement after a change to %s',
		(change) => {
			const grouped = input({
				mode: 'grouped',
				nodes: [node('a', 'Front'), node('b', 'Back')],
				links: [link('relationship', 'a', 'b')],
				groupingAttribute: department
			});
			const before = arrange(grouped);
			const after = arrange({
				...grouped,
				groupingAttribute:
					change === 'Category options'
						? attributeFixture({
								...department,
								options: [...department.answers.map((answer) => answer.value), 'New answer']
							})
						: department,
				nodes: grouped.nodes.map((worker) => ({
					...worker,
					...(change === 'other Category'
						? {
								attributes: {
									...worker.attributes,
									...answerIdsFixture({ shift: 'Night' })
								}
							}
						: {}),
					...(change === 'name' ? { name: 'Renamed Worker' } : {}),
					...(change === 'Assessment' ? { assessment: 'Leader' as const } : {})
				}))
			});
			expect(after).toBe(before);
		}
	);

	it('reuses the grouped Arrangement after editing an existing answer to another Category', () => {
		const withShift = (id: string, dept: string, shift: string): WorkerGraphNode => ({
			...node(id, dept),
			attributes: answerIdsFixture({ dept, shift })
		});
		const grouped = input({
			mode: 'grouped',
			nodes: [withShift('a', 'Front', 'Day'), withShift('b', 'Back', 'Day')],
			links: [link('relationship', 'a', 'b')],
			groupingAttribute: department
		});
		const before = arrange(grouped);
		const after = arrange({
			...grouped,
			nodes: [withShift('a', 'Front', 'Night'), withShift('b', 'Back', 'Day')]
		});
		expect(after).toBe(before);
	});

	it('reuses the free Arrangement after Category answer edits', () => {
		const original = input({
			mode: 'free',
			nodes: [node('a', 'Front'), node('b', 'Back')],
			links: [link('relationship', 'a', 'b')]
		});
		const before = arrange(original);
		const after = arrange({ ...original, nodes: [node('a', 'Back'), node('b', 'Front')] });
		expect(after).toBe(before);
	});

	it('curves cross-group ties and leaves in-group ties straight', () => {
		const nodes = [node('a', 'Front'), node('b', 'Front'), node('c', 'Back'), node('d', 'Back')];
		const links = [
			link('within-front', 'a', 'b'),
			link('within-back', 'c', 'd'),
			link('bridge', 'a', 'c')
		];

		const result = arrange(input({ mode: 'grouped', nodes, links, groupingAttribute: department }));

		expect([...result.crossLinkIds]).toEqual(['bridge']);
		expect(result.centres.size).toBe(2);
		// Every Worker still draws, whichever group it belongs to.
		expect(result.positions.size).toBe(4);
	});

	it('attracts tied groups without pulling together equally busy untied groups', () => {
		const groups = ['A', 'B', 'C', 'D', 'E', 'F'];
		const nodes = groups.flatMap((group) =>
			Array.from({ length: 3 }, (_, index) => node(`${group}${index}`, group, 3))
		);
		const links = [
			link('ab1', 'A0', 'B0'),
			link('ab2', 'A1', 'B1'),
			link('ab3', 'A2', 'B2'),
			link('ce1', 'C0', 'E0'),
			link('ce2', 'C1', 'E1'),
			link('ce3', 'C2', 'E2'),
			link('df1', 'D0', 'F0'),
			link('df2', 'D1', 'F1'),
			link('df3', 'D2', 'F2')
		];
		const result = arrange(
			input({
				mode: 'grouped',
				nodes,
				links,
				groupingAttribute: attributeFixture({ ...department, options: groups }),
				canvas: { width: 1800, height: 1200 },
				gap: 20
			})
		);
		const distance = (a: string, b: string) => {
			const first = result.centres.get(dk(a))!;
			const second = result.centres.get(dk(b))!;
			return Math.hypot(first.x - second.x, first.y - second.y);
		};
		expect(result.positions.size).toBe(nodes.length);
		expect(distance('A', 'B')).toBeLessThan(distance('C', 'D'));
	});

	it('places stronger Relationships into a closer quotient neighbourhood', () => {
		const groups = ['A', 'B', 'C', 'D', 'E', 'F'];
		const nodes = groups.flatMap((group) =>
			Array.from({ length: 6 }, (_, index) => node(`${group}${index}`, group, 3))
		);
		const links: WorkerGraphLink[] = [];
		const addTies = (prefix: string, from: string, to: string, count: number) => {
			for (let index = 0; index < count; index += 1) {
				links.push(
					link(`${prefix}${index}`, `${from}${Math.floor(index / 6)}`, `${to}${index % 6}`)
				);
			}
		};
		// A/B/C/D each have twelve outward Relationships. A/C share eight;
		// B/D are equally busy but have no Relationship with one another.
		addTies('ac', 'A', 'C', 8);
		addTies('ab', 'A', 'B', 4);
		addTies('cd', 'C', 'D', 4);
		addTies('be', 'B', 'E', 8);
		addTies('df', 'D', 'F', 8);
		const result = arrange(
			input({
				mode: 'grouped',
				nodes,
				links,
				groupingAttribute: attributeFixture({ ...department, options: groups }),
				canvas: { width: 2400, height: 1600 },
				gap: 30
			})
		);
		const distance = (a: string, b: string) => {
			const first = result.centres.get(dk(a))!;
			const second = result.centres.get(dk(b))!;
			return Math.hypot(first.x - second.x, first.y - second.y);
		};
		// E reaches A in two quotient steps and C in three. The ellipse seed
		// reverses this ordering on the same public arrange input; the canvas fit
		// may fold the chain until the two are level, but not reverse it.
		expect(distance('E', 'A')).toBeLessThan(distance('E', 'C') * 1.05);
		// The direct eight-tie pair must stay no further than the equally busy but
		// only transitively connected B/D pair. Fitting the chain to the canvas
		// folds it, which can bring B and D level with A and C.
		expect(distance('A', 'C')).toBeLessThan(distance('B', 'D') * 1.05);
	});

	it('keeps a strongly related pair closer than equally busy groups in other components', () => {
		const groups = ['A', 'B', 'C', 'D', 'E', 'F'];
		const nodes = groups.flatMap((group) =>
			Array.from({ length: 6 }, (_, index) => node(`${group}${index}`, group, 2))
		);
		const links = [
			...Array.from({ length: 8 }, (_, index) =>
				link(`ab${index}`, `A${Math.floor(index / 6)}`, `B${index % 6}`)
			),
			...Array.from({ length: 8 }, (_, index) =>
				link(`ce${index}`, `C${Math.floor(index / 6)}`, `E${index % 6}`)
			),
			...Array.from({ length: 8 }, (_, index) =>
				link(`df${index}`, `D${Math.floor(index / 6)}`, `F${index % 6}`)
			)
		];
		const result = arrange(
			input({
				mode: 'grouped',
				nodes,
				links,
				groupingAttribute: attributeFixture({ ...department, options: groups }),
				canvas: { width: 2400, height: 1600 },
				gap: 30
			})
		);
		const distance = (a: string, b: string) => {
			const first = result.centres.get(dk(a))!;
			const second = result.centres.get(dk(b))!;
			return Math.hypot(first.x - second.x, first.y - second.y);
		};

		expect(distance('A', 'B')).toBeLessThan(distance('C', 'D'));
	});

	it('packs disconnected unequal groups with the requested body gap and keeps empty input empty', () => {
		const nodes = [
			node('front-1', 'Front'),
			node('front-2', 'Front'),
			...Array.from({ length: 6 }, (_, index) => node(`back-${index}`, 'Back')),
			node('unanswered', '')
		];
		const gap = 32;
		const result = arrange(
			input({ mode: 'grouped', nodes, links: [], groupingAttribute: department, gap })
		);
		const radius = (group: string) =>
			Math.max(
				...nodes
					.filter((worker) => answerText(worker, 'dept') === group)
					.map((worker) => {
						const point = result.positions.get(worker.id)!;
						const centre = result.centres.get(dk(group))!;
						return (
							Math.hypot(point.x - centre.x, point.y - centre.y) +
							nodeRadius(worker.relationshipCount)
						);
					})
			);
		for (const [first, second] of [
			['Front', 'Back'],
			['Front', ''],
			['Back', '']
		]) {
			const a = result.centres.get(dk(first))!;
			const b = result.centres.get(dk(second))!;
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
				radius(first) + radius(second) + gap - 1
			);
		}
		const empty = arrange(
			input({ mode: 'grouped', nodes: [], links: [], groupingAttribute: department })
		);
		expect(empty.positions.size).toBe(0);
		expect(empty.centres.size).toBe(0);
	});

	it('puts a lone group at its own centre with no physics to run', () => {
		const nodes = [node('a', 'Front'), node('b', 'Front')];
		const links = [link('l1', 'a', 'b')];

		const result = arrange(input({ mode: 'grouped', nodes, links, groupingAttribute: department }));

		expect(result.centres.size).toBe(1);
		expect(result.positions.size).toBe(2);
	});

	it('curves cross-group ties and leaves in-group ties straight', () => {
		const nodes = [node('a', 'Front'), node('b', 'Front'), node('c', 'Back'), node('d', 'Back')];
		const links = [
			link('within-front', 'a', 'b'),
			link('within-back', 'c', 'd'),
			link('bridge', 'a', 'c')
		];

		const result = arrange(input({ mode: 'grouped', nodes, links, groupingAttribute: department }));

		expect([...result.crossLinkIds]).toEqual(['bridge']);
		expect(result.centres.size).toBe(2);
		// Every Worker still draws, whichever group it belongs to.
		expect(result.positions.size).toBe(4);
	});

	it('puts a lone group at its own centre with no physics to run', () => {
		const nodes = [node('a', 'Front'), node('b', 'Front')];
		const links = [link('l1', 'a', 'b')];

		const result = arrange(input({ mode: 'grouped', nodes, links, groupingAttribute: department }));

		expect(result.centres.size).toBe(1);
		expect(result.positions.size).toBe(2);
	});

	it('takes no focus, so isolating a Worker cannot move a dot', () => {
		const nodes = [node('a', 'Front'), node('b', 'Front'), node('c', 'Back')];
		const links = [link('l1', 'a', 'b'), link('l2', 'a', 'c')];
		const free = input({ mode: 'free', nodes, links });
		const grouped = input({ mode: 'grouped', nodes, links, groupingAttribute: department });

		// The arrangement is keyed on the layout set alone; the selection and the
		// Isolate neighbourhood are not inputs, so a click re-runs nothing.
		expect(arrange({ ...free })).toBe(arrange(free));
		expect(arrange({ ...grouped })).toBe(arrange(grouped));
		expect('selectedId' in free).toBe(false);
	});

	describe('Free layout by physics', () => {
		const nodes = Array.from({ length: 12 }, (_, i) => node(`w${i}`, '', i % 4));
		const links = Array.from({ length: 11 }, (_, i) => link(`l${i}`, `w${i}`, `w${i + 1}`));

		it('keeps a giant inferred community complete without whole-worksite stress', () => {
			const workers = Array.from({ length: 500 }, (_, i) =>
				node(`giant-${i}`, '', i === 0 ? 499 : 1)
			);
			const ties = workers
				.slice(1)
				.map((worker, i) => link(`giant-tie-${i}`, workers[0].id, worker.id));
			const before = stressPairVisits();
			const checksBefore = separationPairChecks();
			const request = input({ mode: 'free', nodes: workers, links: ties });
			const result = arrange(request);
			expect(result.positions.size).toBe(500);
			expect(stressPairVisits() - before).toBe(0);
			// Measured 2,691,218; the all-pairs pass made 44,910,000.
			expect(separationPairChecks() - checksBefore).toBeLessThanOrEqual(2_800_000);
			expect(ties).toHaveLength(499);
			expect(result.regions).toEqual([]);
			expect(
				[...result.positions.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
			).toBe(true);
			arrange(input({ mode: 'free', nodes: [], links: [] }));
			expect(arrange(request).positions).toEqual(result.positions);
		});

		it('gives the same layout on every run', () => {
			const a = arrange(input({ mode: 'free', nodes, links, canvas: { width: 801, height: 600 } }));
			const first = [...a.positions];
			const b = arrange(input({ mode: 'free', nodes, links, canvas: { width: 802, height: 600 } }));
			const c = arrange(input({ mode: 'free', nodes, links, canvas: { width: 801, height: 600 } }));
			expect(b.positions.size).toBe(first.length);
			expect([...c.positions]).toEqual(first);
		});

		describe('social structure', () => {
			const setA = Array.from({ length: 7 }, (_, i) => `a${i}`);
			const setB = Array.from({ length: 7 }, (_, i) => `b${i}`);
			const loner = 'loner';
			const social = [...setA, ...setB, loner].map((id) => node(id, '', 3));
			const socialLinks: WorkerGraphLink[] = [];
			for (const set of [setA, setB]) {
				for (let p = 0; p < set.length; p += 1) {
					for (let q = p + 1; q < set.length; q += 1) {
						socialLinks.push(link(`${set[p]}-${set[q]}`, set[p], set[q]));
					}
				}
			}
			socialLinks.push(link('bridge', 'a0', 'b0'));
			const run = () => arrange(input({ mode: 'free', nodes: social, links: socialLinks }));
			const centroid = (ids: string[], positions: Map<string, { x: number; y: number }>) => ({
				x: ids.reduce((sum, id) => sum + positions.get(id)!.x, 0) / ids.length,
				y: ids.reduce((sum, id) => sum + positions.get(id)!.y, 0) / ids.length
			});

			it('leaves each dense set nearer its own set', () => {
				const { positions } = run();
				const ca = centroid(setA, positions);
				const cb = centroid(setB, positions);
				for (const [ids, own, other] of [
					[setA, ca, cb],
					[setB, cb, ca]
				] as const) {
					for (const id of ids) {
						const p = positions.get(id)!;
						expect(Math.hypot(p.x - own.x, p.y - own.y)).toBeLessThan(
							Math.hypot(p.x - other.x, p.y - other.y)
						);
					}
				}
			});

			it('gives identical positions on two runs', () => {
				const first = [...run().positions];
				const again = arrange(input({ mode: 'free', nodes: social, links: socialLinks, gap: 81 }));
				expect([...again.positions]).toEqual(first);
			});

			it('keeps a worker with no Relationships near the clumps', () => {
				const { positions } = run();
				const members = [...setA, ...setB].map((id) => positions.get(id)!);
				let extent = 0;
				for (const p of members) {
					for (const q of members) extent = Math.max(extent, Math.hypot(p.x - q.x, p.y - q.y));
				}
				const p = positions.get(loner)!;
				const nearest = Math.min(...members.map((m) => Math.hypot(p.x - m.x, p.y - m.y)));
				expect(nearest).toBeLessThanOrEqual(extent + 80);
			});
		});

		it('leaves no two dots overlapping', () => {
			const { positions } = arrange(input({ mode: 'free', nodes, links }));
			const ids = [...positions.keys()];
			for (let i = 0; i < ids.length; i += 1) {
				for (let j = i + 1; j < ids.length; j += 1) {
					const p = positions.get(ids[i])!;
					const q = positions.get(ids[j])!;
					const r =
						nodeRadius(nodes.find((n) => n.id === ids[i])!.relationshipCount) +
						nodeRadius(nodes.find((n) => n.id === ids[j])!.relationshipCount);
					expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(r - 0.01);
				}
			}
		});
	});
});

describe('arrange fitting the canvas ratio', () => {
	const departments = ['Front', 'Back', 'Bar', 'Host'];
	const nodes = Array.from({ length: 40 }, (_, i) => node(`w${i}`, departments[i % 4], 2));
	const links = Array.from({ length: 39 }, (_, i) => link(`l${i}`, `w${i}`, `w${i + 1}`));
	const multi = attributeFixture({ ...department, options: departments });

	function extent(result: ReturnType<typeof arrange>) {
		return { w: result.max.x - result.min.x, h: result.max.y - result.min.y };
	}

	function centresSpread(result: ReturnType<typeof arrange>) {
		const points = [...result.centres.values()];
		const xs = points.map((p) => p.x);
		const ys = points.map((p) => p.y);
		return {
			w: Math.max(...xs) - Math.min(...xs),
			h: Math.max(...ys) - Math.min(...ys)
		};
	}

	it('spreads a fresh Free arrangement wider than tall on a wide canvas', () => {
		const { w, h } = extent(
			arrange(input({ mode: 'free', nodes, links, canvas: { width: 1200, height: 600 } }))
		);
		expect(w).toBeGreaterThan(h);
	});

	it('spreads Grouped group centres wider than tall on a wide canvas', () => {
		const { w, h } = centresSpread(
			arrange(
				input({
					mode: 'grouped',
					nodes,
					links,
					groupingAttribute: multi,
					canvas: { width: 1200, height: 600 }
				})
			)
		);
		expect(w).toBeGreaterThan(h);
	});

	it('fits Relationship-driven geometry uniformly on a square canvas', () => {
		const free = extent(
			arrange(input({ mode: 'free', nodes, links, canvas: { width: 800, height: 800 } }))
		);
		// Relationships determine the shape; fitting must preserve that shape.
		expect(free.w).toBeGreaterThan(0);
		expect(free.h).toBeGreaterThan(0);
		// Free layouts spread across 1.95× the canvas; the camera fits the result.
		expect(free.w).toBeLessThanOrEqual(800 * 1.95);
		expect(free.h).toBeLessThanOrEqual(800 * 1.95);
		const grouped = centresSpread(
			arrange(
				input({
					mode: 'grouped',
					nodes,
					links,
					groupingAttribute: multi,
					canvas: { width: 800, height: 800 }
				})
			)
		);
		// Group proportions now follow only actual shared Relationships. A
		// square canvas therefore need not make an unrelated group pair attract.
		expect(Number.isFinite(grouped.w)).toBe(true);
		expect(Number.isFinite(grouped.h)).toBe(true);
		expect(grouped.w).toBeLessThanOrEqual(800);
		expect(grouped.h).toBeLessThanOrEqual(800);
	});
});

describe('arrange with a dot drag', () => {
	const nodes = [node('a', '', 1), node('b', '', 1), node('c', '', 1), node('d', '', 1)];
	const links = [link('l1', 'a', 'b'), link('l2', 'b', 'c')];
	const workerManual = (id: string, x: number, y: number): ManualGeometry => ({
		groupShift: new Map(),
		workerShift: new Map([[id, { x, y }]])
	});

	it('moves only the dragged Worker: its neighbours stay exactly where they were', () => {
		const rest = arrange(input({ mode: 'free', nodes, links })).positions;
		const result = arrange(
			input({ mode: 'free', nodes, links, manual: workerManual('b', 100, -50) })
		).positions;
		expect(result.get('b')).toEqual({ x: rest.get('b')!.x + 100, y: rest.get('b')!.y - 50 });
		for (const id of ['a', 'c', 'd']) expect(result.get(id)).toEqual(rest.get(id));
	});

	it('moves a Grouped Worker alone too, and never recomputes the automatic arrangement', () => {
		const grouped = [node('a', 'Front'), node('b', 'Front'), node('c', 'Back'), node('d', 'Back')];
		const gl = [link('l1', 'a', 'b'), link('l2', 'a', 'c')];
		const base = input({
			mode: 'grouped',
			nodes: grouped,
			links: gl,
			groupingAttribute: department
		});
		const rest = arrange(base);
		const moved = arrange({ ...base, manual: workerManual('a', 40, 0) });
		expect(moved.revision).toBe(rest.revision);
		expect(moved.positions.get('a')!.x).toBeCloseTo(rest.positions.get('a')!.x + 40);
		for (const id of ['b', 'c', 'd'])
			expect(moved.positions.get(id)).toEqual(rest.positions.get(id));
		expect([...moved.centres]).toEqual([...rest.centres]);
	});
});

describe('arrange re-heating the Free layout', () => {
	describe('with a Sub-grouping', () => {
		const shift = attributeFixture({
			id: 'shift',
			name: 'Shift',
			kind: 'category',
			options: ['Day', 'Night', 'Swing']
		});
		const departments = ['Front', 'Back', 'Bar'];
		const nodes = Array.from({ length: 36 }, (_, i) => ({
			...node(`w${i}`, departments[i % 3], 2),
			attributes: answerIdsFixture({
				dept: departments[i % 3],
				shift: ['Day', 'Night', 'Swing'][(i >> 2) % 3]
			})
		}));
		const links = Array.from({ length: 35 }, (_, i) => link(`l${i}`, `w${i}`, `w${i + 1}`));
		const grouped = input({
			mode: 'grouped',
			nodes,
			links,
			groupingAttribute: attributeFixture({ ...department, options: departments }),
			subGroupingAttribute: shift,
			canvas: { width: 3000, height: 2400 }
		});

		it('is identical across runs', () => {
			const first = arrange(grouped);
			const second = arrange({ ...grouped, gap: 81 });
			const third = arrange({ ...grouped, gap: 80, nodes: [...nodes] });
			expect([...third.positions]).toEqual([...first.positions]);
			expect(second.positions.size).toBe(first.positions.size);
		});

		it('keeps group regions from touching', () => {
			const { positions } = arrange(grouped);
			const regions = layoutGroupRegions(
				departments.map((value) => ({
					value,
					label: value,
					subGroups: shift.answers.map((a) => ({ value: a.value, label: a.value }))
				})),
				nodes.map((n) => ({
					...positions.get(n.id)!,
					group: answerText(n, 'dept'),
					subGroup: answerText(n, 'shift')
				}))
			);
			for (const a of regions) {
				for (const b of regions) {
					if (a === b) continue;
					const touching = b.hull.some((p) => insideHull(a.hull, p));
					expect(touching).toBe(false);
				}
			}
		});

		it('keeps sub-labels from overlapping each other', () => {
			const { positions } = arrange(grouped);
			const regions = layoutGroupRegions(
				departments.map((value) => ({
					value,
					label: value,
					subGroups: shift.answers.map((a) => ({ value: a.value, label: a.value }))
				})),
				nodes.map((n) => ({
					...positions.get(n.id)!,
					group: answerText(n, 'dept'),
					subGroup: answerText(n, 'shift')
				}))
			);
			const boxes = regions.flatMap((region) =>
				region.subRegions.map(({ label, labelAt: { x, y, textAnchor } }) => {
					const width = (label.length + 4) * 5.4;
					const left =
						textAnchor === 'start' ? x : textAnchor === 'end' ? x - width : x - width / 2;
					return { left, right: left + width, top: y - 12, bottom: y + 2 };
				})
			);
			expect(boxes.length).toBe(9);
			for (let i = 0; i < boxes.length; i += 1) {
				for (let j = i + 1; j < boxes.length; j += 1) {
					const a = boxes[i];
					const b = boxes[j];
					const overlap =
						a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
					expect(overlap).toBe(false);
				}
			}
		});

		it('separates every pair of Workers by more than their dots', () => {
			const { positions } = arrange(grouped);
			const points = [...positions.values()];
			for (let i = 0; i < points.length; i += 1) {
				for (let j = i + 1; j < points.length; j += 1) {
					expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)).toBeGreaterThan(
						nodeRadius(2)
					);
				}
			}
		});
	});
});

function insideHull(polygon: readonly { x: number; y: number }[], point: { x: number; y: number }) {
	const signs = polygon.map((vertex, index) => {
		const next = polygon[(index + 1) % polygon.length];
		return Math.sign(
			(next.x - vertex.x) * (point.y - vertex.y) - (next.y - vertex.y) * (point.x - vertex.x)
		);
	});
	return signs.every((sign) => sign > 0) || signs.every((sign) => sign < 0);
}

describe('arrangement labels', () => {
	const nodes = Array.from({ length: 12 }, (_, i) => node(String(i), `Department ${i}`));
	const base = input({ mode: 'grouped', nodes, links: [], groupingAttribute: department });
	const room = { x: -300, y: -180, width: 600, height: 360 };
	const intersects = (
		a: { x: number; y: number; width: number; height: number },
		b: { x: number; y: number; width: number; height: number }
	) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

	it('places every group label inside the free canvas, without collisions, deterministically', () => {
		const request = { ...base, labelView: { freeCanvas: room } };
		const first = arrange(request);
		expect(first.regions).toHaveLength(12);
		const boxes = first.regions.map((region) => region.labelBox!);
		for (const [i, box] of boxes.entries()) {
			expect(box.x).toBeGreaterThanOrEqual(room.x);
			expect(box.y).toBeGreaterThanOrEqual(room.y);
			expect(box.x + box.width).toBeLessThanOrEqual(room.x + room.width);
			expect(box.y + box.height).toBeLessThanOrEqual(room.y + room.height);
			for (const other of boxes.slice(i + 1)) expect(intersects(box, other)).toBe(false);
		}
		expect(arrange(request)).toBe(first);
		expect(
			arrange({ ...request, nodes: nodes.map((n) => ({ ...n, assessment: 'Leader' as const })) })
		).toBe(first);
		arrange({ ...base, gap: 99 });
		expect(arrange(request).regions).toEqual(first.regions);
	});

	it('moves labels with translated group geometry and reuses the worker arrangement', () => {
		const original = arrange(base);
		const before = arrange({ ...base, labelView: { freeCanvas: room } });
		const moved = arrange({
			...base,
			labelView: {
				freeCanvas: { ...room, x: room.x + 100, y: room.y + 50 },
				positions: new Map(
					[...original.positions].map(([id, p]) => [id, { x: p.x + 100, y: p.y + 50 }])
				)
			}
		});
		expect(moved.positions).toBe(original.positions);
		for (const [i, region] of moved.regions.entries()) {
			expect(region.labelAt.x).toBeCloseTo(before.regions[i].labelAt.x + 100);
			expect(region.labelAt.y).toBeCloseTo(before.regions[i].labelAt.y + 50);
		}
	});
});

it('packs parent and sibling labels, and truncates long names without losing their full text', () => {
	const long = 'Department with a very long name '.repeat(12);
	const shift = attributeFixture({
		id: 'shift',
		name: 'Shift',
		kind: 'category',
		options: ['Early', 'Late']
	});
	const nodes = ['a', 'b', 'c', 'd'].map((id, i) => ({
		...node(id, long),
		attributes: answerIdsFixture({ dept: long, shift: i % 2 ? 'Late' : 'Early' })
	}));
	const result = arrange(
		input({
			mode: 'grouped',
			nodes,
			links: [],
			groupingAttribute: attributeFixture({ ...department, options: [long] }),
			subGroupingAttribute: shift,
			labelView: { freeCanvas: { x: -160, y: -120, width: 320, height: 240 } }
		})
	);
	const parent = result.regions[0];
	expect(parent.label).toBe(long);
	expect(parent.displayLabel).toMatch(/…$/);
	const regions = [parent, ...parent.subRegions];
	for (const [i, region] of regions.entries()) {
		const a = region.labelBox!;
		for (const other of regions.slice(i + 1)) {
			const b = other.labelBox!;
			expect(
				a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
			).toBe(false);
		}
	}
});

it('gives isolated groups first choice and keeps context labels off Worker names', () => {
	const nodes = [node('isolated', 'Z'), node('context', 'A')];
	const base = input({ mode: 'grouped', nodes, links: [], groupingAttribute: department });
	const positions = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]));
	const room = { x: -200, y: -150, width: 400, height: 300 };
	const isolated = arrange({
		...base,
		labelView: { positions, freeCanvas: room, priorityIds: new Set(['isolated']) }
	});
	const priority = isolated.regions.find((r) => r.label === 'Z')!;
	const alone = arrange({ ...base, labelView: { nodes: [nodes[0]], positions, freeCanvas: room } });
	expect(priority.labelAt).toEqual(alone.regions[0].labelAt);
	const obstacle = priority.labelBox!;
	const reserved = arrange({
		...base,
		labelView: { positions, freeCanvas: room, obstacles: [obstacle] }
	});
	for (const region of reserved.regions) {
		const box = region.labelBox!;
		expect(
			box.x < obstacle.x + obstacle.width &&
				obstacle.x < box.x + box.width &&
				box.y < obstacle.y + obstacle.height &&
				obstacle.y < box.y + box.height
		).toBe(false);
	}
});

it('keeps a compact, accessible name visible when Worker names occupy normal slots', () => {
	const room = { x: -100, y: -100, width: 200, height: 200 };
	const result = arrange(
		input({
			mode: 'grouped',
			nodes: [node('a', 'Front')],
			links: [],
			groupingAttribute: department,
			labelView: { freeCanvas: room, obstacles: [room] }
		})
	);
	const region = result.regions[0];
	expect(region.displayLabel).toBe('…');
	expect(region.label).toBe('Front');
	expect(region.labelBox!.x).toBeGreaterThanOrEqual(room.x);
	expect(region.labelBox!.y).toBeGreaterThanOrEqual(room.y);
	expect(region.labelBox!.x + region.labelBox!.width).toBeLessThanOrEqual(room.x + room.width);
});

it('fits an ellipsis into a narrow gap before yielding any isolated Worker name', () => {
	const room = { x: 0, y: 0, width: 100, height: 40 };
	const obstacle = { ...room, width: 80 };
	const result = arrange(
		input({
			mode: 'grouped',
			nodes: [node('a', 'Front')],
			links: [],
			groupingAttribute: department,
			labelView: { freeCanvas: room, obstacles: [obstacle] }
		})
	);
	const region = result.regions[0];
	expect(region.displayLabel).toBe('…');
	expect(region.labelBox!.x).toBeGreaterThanOrEqual(80);
});

describe('arrange given a fixed layout canvas', () => {
	it('is unchanged when only the live canvas differs, because the layout canvas is what it reads', () => {
		const nodes = Array.from({ length: 12 }, (_, i) => node(`w${i}`, i % 2 ? 'Front' : 'Back', 1));
		const links = Array.from({ length: 11 }, (_, i) => link(`l${i}`, `w${i}`, `w${i + 1}`));
		const layoutCanvas = { width: 900, height: 600 };
		const first = arrange(input({ mode: 'free', nodes, links, canvas: layoutCanvas }));
		// A resize changes the live size only; the caller keeps handing arrange the layout canvas.
		const afterResize = arrange(input({ mode: 'free', nodes, links, canvas: { ...layoutCanvas } }));
		expect([...afterResize.positions]).toEqual([...first.positions]);
	});
});

describe('settled bridge orientation', () => {
	const workers = ['A', 'B'].flatMap((group) =>
		Array.from({ length: 4 }, (_, i) => node(`${group}${i}`, group, i === 0 ? 4 : 3))
	);
	const ties: WorkerGraphLink[] = [];
	for (const group of ['A', 'B'])
		for (let a = 0; a < 4; a += 1)
			for (let b = a + 1; b < 4; b += 1) {
				ties.push(link(`${group}${a}-${b}`, `${group}${a}`, `${group}${b}`));
			}
	ties.push(link('bridge', 'A0', 'B0'));

	it('faces actual partners after settling at very different group gaps', () => {
		const request = input({
			mode: 'grouped',
			nodes: workers,
			links: ties,
			groupingAttribute: department,
			canvas: { width: 4000, height: 3000 }
		});
		const close = arrange({ ...request, gap: 20 });
		const far = arrange({ ...request, gap: 600 });
		expect(
			Math.hypot(
				far.centres.get(dk('A'))!.x - close.centres.get(dk('A'))!.x,
				far.centres.get(dk('A'))!.y - close.centres.get(dk('A'))!.y
			)
		).toBeGreaterThan(100);
		for (const result of [close, far]) {
			for (const [group, partner] of [
				['A', 'B'],
				['B', 'A']
			]) {
				const centre = result.centres.get(dk(group))!;
				const port = result.positions.get(`${group}0`)!;
				const target = result.positions.get(`${partner}0`)!;
				const ox = port.x - centre.x,
					oy = port.y - centre.y;
				const dx = target.x - centre.x,
					dy = target.y - centre.y;
				// Within ~20°: the final tidy may turn a port off its partner to clear
				// a crossing or a cramped neighbour.
				expect((ox * dx + oy * dy) / (Math.hypot(ox, oy) * Math.hypot(dx, dy))).toBeGreaterThan(
					0.94
				);
			}
		}
		arrange(input({ mode: 'free', nodes: [], links: [] }));
		expect(arrange({ ...request, gap: 20 }).positions).toEqual(close.positions);
	});
});

describe('nested settled partners', () => {
	const subCategory = attributeFixture({
		id: 'sub',
		name: 'Sub',
		kind: 'category',
		options: ['Alpha', 'Bravo', 'Charlie']
	});
	const workers = ['Alpha', 'Bravo', 'Charlie'].flatMap((sub) =>
		Array.from({ length: 4 }, (_, i) => ({
			...node(`${sub}-${i}`, 'Parent', sub === 'Charlie' && i === 0 ? 7 : 4),
			attributes: answerIdsFixture({ dept: 'Parent', sub })
		}))
	);
	const ties: WorkerGraphLink[] = [];
	for (const sub of subCategory.answers.map((a) => a.value))
		for (let a = 0; a < 4; a += 1)
			for (let b = a + 1; b < 4; b += 1) {
				ties.push(link(`${sub}-${a}-${b}`, `${sub}-${a}`, `${sub}-${b}`));
			}
	for (let i = 0; i < 4; i += 1) ties.push(link(`strong-${i}`, 'Charlie-0', `Bravo-${i}`));
	ties.push(link('weak', 'Alpha-0', 'Bravo-0'));
	const request = input({
		mode: 'grouped',
		nodes: workers,
		links: ties,
		groupingAttribute: department,
		subGroupingAttribute: subCategory,
		canvas: { width: 4000, height: 3000 }
	});
	const centroid = (result: ReturnType<typeof arrange>, sub: string) => ({
		x:
			workers
				.filter((n) => answerText(n, 'sub') === sub)
				.reduce((sum, n) => sum + result.positions.get(n.id)!.x, 0) / 4,
		y:
			workers
				.filter((n) => answerText(n, 'sub') === sub)
				.reduce((sum, n) => sum + result.positions.get(n.id)!.y, 0) / 4
	});

	it('faces the actual sibling when alphabetical and outward-count orders differ', () => {
		const result = arrange(request);
		const from = centroid(result, 'Charlie');
		const target = centroid(result, 'Bravo');
		const port = result.positions.get('Charlie-0')!;
		const ox = port.x - from.x,
			oy = port.y - from.y;
		const dx = target.x - from.x,
			dy = target.y - from.y;
		expect((ox * dx + oy * dy) / (Math.hypot(ox, oy) * Math.hypot(dx, dy))).toBeGreaterThan(0.9);
		const alpha = centroid(result, 'Alpha');
		expect(Math.hypot(from.x - target.x, from.y - target.y)).toBeLessThan(
			Math.hypot(from.x - alpha.x, from.y - alpha.y)
		);
	});
	it('uses actual outside-parent endpoints with one child and Unanswered membership', () => {
		const all = ['Inside', 'Outside'].flatMap((group) =>
			Array.from({ length: 4 }, (_, i) => ({
				...node(`${group}-${i}`, group, i === 0 ? 4 : 3),
				attributes: answerIdsFixture({
					dept: group,
					sub: group === 'Inside' ? 'Alpha' : ''
				})
			}))
		);
		const links: WorkerGraphLink[] = [];
		for (const group of ['Inside', 'Outside'])
			for (let a = 0; a < 4; a += 1)
				for (let b = a + 1; b < 4; b += 1) {
					links.push(link(`${group}-${a}-${b}`, `${group}-${a}`, `${group}-${b}`));
				}
		links.push(link('external', 'Inside-0', 'Outside-0'));
		const externalRequest = { ...request, nodes: all, links };
		const result = arrange(externalRequest);
		for (const [group, partner] of [
			['Inside', 'Outside'],
			['Outside', 'Inside']
		]) {
			const centre = result.centres.get(dk(group))!;
			const port = result.positions.get(`${group}-0`)!;
			const target = result.positions.get(`${partner}-0`)!;
			const ox = port.x - centre.x,
				oy = port.y - centre.y;
			const dx = target.x - centre.x,
				dy = target.y - centre.y;
			expect((ox * dx + oy * dy) / (Math.hypot(ox, oy) * Math.hypot(dx, dy))).toBeGreaterThan(0.98);
		}
		expect(result.positions.size).toBe(8);
		expect(
			result.regions.flatMap((r) => r.subRegions).some((r) => r.key.endsWith('::__unassigned'))
		).toBe(true);
		arrange(input({ mode: 'free', nodes: [], links: [] }));
		expect(arrange(externalRequest).positions).toEqual(result.positions);
	});

	it('keeps nested internal vectors when the parent group is moved', () => {
		const before = arrange(request);
		const after = arrange({
			...request,
			manual: { groupShift: new Map([['Parent', { x: 400, y: 200 }]]), workerShift: new Map() }
		});
		for (const a of workers)
			for (const b of workers) {
				expect(after.positions.get(a.id)!.x - after.positions.get(b.id)!.x).toBeCloseTo(
					before.positions.get(a.id)!.x - before.positions.get(b.id)!.x,
					8
				);
				expect(after.positions.get(a.id)!.y - after.positions.get(b.id)!.y).toBeCloseTo(
					before.positions.get(a.id)!.y - before.positions.get(b.id)!.y,
					8
				);
			}
	});
});

describe('open-space leaf fans', () => {
	const workers = ['hub', 'core-a', 'core-b', 'leaf-a', 'leaf-b', 'leaf-c'].map((id) => ({
		...node(id, 'Parent', id === 'hub' ? 5 : id.startsWith('leaf') ? 1 : 2),
		attributes: answerIdsFixture({ dept: 'Parent', sub: 'Only' })
	}));
	const links = workers.slice(1).map((n) => link(`hub-${n.id}`, 'hub', n.id));
	links.push(link('core', 'core-a', 'core-b'));
	it.each(['free', 'grouped', 'nested'])(
		'spreads several leaves evenly through open space in %s',
		(variant) => {
			const result = arrange(
				input({
					mode: variant === 'free' ? 'free' : 'grouped',
					nodes: workers,
					links,
					groupingAttribute: variant === 'free' ? undefined : department,
					subGroupingAttribute:
						variant === 'nested'
							? {
									id: 'sub',
									name: 'Sub',
									kind: 'category',
									answers: [{ id: 'sub~Only', value: 'Only' }]
								}
							: undefined
				})
			);
			const hub = result.positions.get('hub')!;
			const angle = (id: string) => {
				const p = result.positions.get(id)!;
				return (Math.atan2(p.y - hub.y, p.x - hub.x) + Math.PI * 2) % (Math.PI * 2);
			};
			const occupied = ['core-a', 'core-b'].map(angle).sort((a, b) => a - b);
			const forward = occupied[1] - occupied[0];
			const start = forward > Math.PI ? occupied[0] : occupied[1];
			const gap = Math.max(forward, Math.PI * 2 - forward);
			const leaves = ['leaf-a', 'leaf-b', 'leaf-c']
				.map((id) => (angle(id) - start + Math.PI * 2) % (Math.PI * 2))
				.sort((a, b) => a - b);
			for (let i = 0; i < leaves.length; i += 1)
				expect(leaves[i]).toBeCloseTo((gap * (i + 1)) / 4, 1);
		}
	);
});

describe('group move', () => {
	const nodes = ['A', 'B', 'C'].flatMap((dept) => [node(`${dept}1`, dept), node(`${dept}2`, dept)]);
	const links = [link('a', 'A1', 'B1'), link('b', 'B2', 'C1'), link('c', 'A2', 'A1')];
	const request = input({
		mode: 'grouped',
		nodes,
		links,
		groupingAttribute: department,
		canvas: { width: 4000, height: 3000 }
	});
	const rest = arrange(request);
	const moveGroup = (key: string, x: number, y: number): ManualGeometry => ({
		groupShift: new Map([[key, { x, y }]]),
		workerShift: new Map()
	});

	it('translates the group rigidly and leaves every other group exactly still', () => {
		const moved = arrange({ ...request, manual: moveGroup(dk('A'), 3000, 2500) });
		const a = moved.centres.get(dk('A'))!;
		expect(a.x).toBeCloseTo(rest.centres.get(dk('A'))!.x + 3000, 6);
		expect(a.y).toBeCloseTo(rest.centres.get(dk('A'))!.y + 2500, 6);
		for (const key of ['B', 'C']) {
			expect(moved.centres.get(dk(key))).toEqual(rest.centres.get(dk(key)));
			for (const n of nodes.filter((w) => answerText(w, 'dept') === key))
				expect(moved.positions.get(n.id)).toEqual(rest.positions.get(n.id));
		}
		for (const id of ['A1', 'A2']) {
			expect(moved.positions.get(id)!.x - rest.positions.get(id)!.x).toBeCloseTo(3000, 6);
			expect(moved.positions.get(id)!.y - rest.positions.get(id)!.y).toBeCloseTo(2500, 6);
		}
	});

	it('does not displace a neighbour when the moved group lands on it', () => {
		const b = rest.centres.get(dk('B'))!;
		const target = rest.centres.get(dk('A'))!;
		const moved = arrange({
			...request,
			manual: moveGroup(dk('A'), b.x + 5 - target.x, b.y - target.y)
		});
		expect(moved.centres.get(dk('B'))).toEqual(b);
		expect(moved.centres.get(dk('A'))!.x).toBeCloseTo(b.x + 5, 6);
	});

	it('is the same automatic arrangement underneath, and never re-solves a local layout', () => {
		const revision = arrange(request).revision;
		const solved = localLayoutSolves.count;
		for (let step = 1; step <= 5; step += 1) {
			const moved = arrange({ ...request, manual: moveGroup(dk('A'), 100 * step, 50 * step) });
			expect(moved.revision).toBe(revision);
		}
		expect(localLayoutSolves.count).toBe(solved);
	});
});

describe('sibling sub-regions', () => {
	type P = { x: number; y: number };
	const cross = (a: P, b: P, c: P, d: P) => {
		const side = (p: P, q: P, r: P) =>
			Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
		return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
	};
	const hullsIntersect = (a: readonly P[], b: readonly P[]) =>
		a.some((p) => insideHull(b, p)) ||
		b.some((p) => insideHull(a, p)) ||
		a.some((p, i) => b.some((q, j) => cross(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));

	it('keep clear of each other after the final tidy', () => {
		const fixture = createLayoutQualityFixture();
		const { positions } = arrange(qualityArrangeInput(fixture, 'nested'));
		const groups = [...new Set(fixture.groupByWorker.values())].sort();
		const roles = [...new Set(fixture.subGroupByWorker.values())].sort();
		const regions = layoutGroupRegions(
			groups.map((value) => ({
				value,
				label: value,
				subGroups: roles
					.filter((role) => role.startsWith(`${value} /`))
					.map((role) => ({ value: role, label: role }))
			})),
			fixture.nodes.map((n) => ({
				...positions.get(n.id)!,
				group: fixture.groupByWorker.get(n.id)!,
				subGroup: fixture.subGroupByWorker.get(n.id)!
			}))
		);
		let pairs = 0;
		for (const region of regions) {
			for (let i = 0; i < region.subRegions.length; i += 1) {
				for (let j = i + 1; j < region.subRegions.length; j += 1) {
					pairs += 1;
					expect(
						hullsIntersect(region.subRegions[i].hull, region.subRegions[j].hull),
						`${region.subRegions[i].label} / ${region.subRegions[j].label}`
					).toBe(false);
				}
			}
		}
		expect(pairs).toBeGreaterThan(0);
	});
});

describe('independent mounted maps', () => {
	it('does not evict another map cache or re-solve during manual movement', () => {
		const first = createArranger();
		const second = createArranger();
		const request = input({
			mode: 'free',
			nodes: [node('a', 'Front'), node('b', 'Back')],
			links: []
		});
		const initial = first(request);
		second({ ...request, canvas: { width: 333, height: 444 } });
		expect(first(request)).toBe(initial);
		first({
			...request,
			manual: { workerShift: new Map([['a', { x: 2, y: 3 }]]), groupShift: new Map() }
		});
		expect(first.solves).toBe(1);
		expect(second.solves).toBe(1);
	});
});
