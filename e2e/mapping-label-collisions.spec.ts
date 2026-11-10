import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';
import { settled, waitForMapReady } from './map.ts';
import collision11 from './fixtures/mapping-label-collision-seed-11.json' with { type: 'json' };
import collisionDotUngrouped from './fixtures/mapping-label-collision-dot-ungrouped.json' with { type: 'json' };

/**
 * A realistic worksite (50 Workers, 3 Departments, 7 Roles, about 85 ties) read
 * on the rendered map: no name may overlap another name, a region label or a
 * dot that is not its own. Names that sit under a tie are counted, not yet gated.
 */
test.use({ reducedMotion: 'reduce' });

type Counts = {
	collisions: number;
	detail: string[];
	tiesUnderNames: number;
	names: number;
	ties: number;
};

async function measure(page: Page): Promise<Counts> {
	return page.evaluate(() => {
		type Box = { l: number; t: number; r: number; b: number };
		const box = (el: Element): Box => {
			const r = el.getBoundingClientRect();
			return { l: r.left, t: r.top, r: r.right, b: r.bottom };
		};
		const overlap = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
		// A dot's stroke is part of its box; a graze of that width is not a collision.
		const shrunk = (b: Box, by: number): Box => ({
			l: b.l + by,
			t: b.t + by,
			r: b.r - by,
			b: b.b - by
		});
		const names = [...document.querySelectorAll('text[data-node-label]')].map((el) => ({
			id: el.getAttribute('data-node-label') as string,
			box: box(el)
		}));
		const regionLabels = [...document.querySelectorAll('[data-group-hull] text')]
			.map(box)
			.filter((b) => b.r > b.l);
		const dots = [...document.querySelectorAll('g[data-node-id]')].map((g) => {
			const circle = [...g.querySelectorAll('circle')].find(
				(c) => !c.hasAttribute('data-hit-for') && !c.hasAttribute('data-focus-ring')
			) as SVGCircleElement;
			return { id: g.getAttribute('data-node-id') as string, box: box(circle) };
		});
		const ties = [...document.querySelectorAll('path[data-tie]')].map((path) => {
			const p = path as SVGPathElement;
			const m = p.getScreenCTM() as DOMMatrix;
			const len = p.getTotalLength();
			const a = p.getPointAtLength(0).matrixTransform(m);
			const b = p.getPointAtLength(len).matrixTransform(m);
			return { a, b };
		});

		let collisions = 0;
		const detail: string[] = [];
		names.forEach((name, i) => {
			for (let j = i + 1; j < names.length; j++)
				if (overlap(name.box, names[j].box)) {
					collisions++;
					detail.push('name');
				}
			for (const label of regionLabels)
				if (overlap(name.box, label)) {
					collisions++;
					detail.push('region');
				}
			for (const dot of dots)
				if (dot.id !== name.id && overlap(name.box, shrunk(dot.box, 2))) {
					collisions++;
					detail.push('dot');
				}
		});

		const crosses = (box: Box, a: DOMPoint, b: DOMPoint) => {
			let t0 = 0;
			let t1 = 1;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			for (const [p, q] of [
				[-dx, a.x - box.l],
				[dx, box.r - a.x],
				[-dy, a.y - box.t],
				[dy, box.b - a.y]
			]) {
				if (p === 0) {
					if (q < 0) return false;
				} else {
					const t = q / p;
					if (p < 0) t0 = Math.max(t0, t);
					else t1 = Math.min(t1, t);
				}
			}
			return t0 <= t1;
		};
		let tiesUnderNames = 0;
		for (const name of names) {
			const own = dots.find((d) => d.id === name.id) as { box: Box };
			const cx = (own.box.l + own.box.r) / 2;
			const cy = (own.box.t + own.box.b) / 2;
			const near = (p: DOMPoint) => Math.hypot(p.x - cx, p.y - cy) < 1.5;
			for (const tie of ties) {
				if (near(tie.a) || near(tie.b)) continue;
				if (crosses(name.box, tie.a, tie.b)) tiesUnderNames++;
			}
		}
		// Sibling role outlines inside one department that cut into each other.
		let subOverlaps = 0;
		for (const hull of document.querySelectorAll('[data-group-hull]')) {
			const outlines = [...hull.querySelectorAll<SVGPathElement>('g > path.fill-chip')];
			const inside = (from: SVGPathElement, into: SVGPathElement) => {
				const length = from.getTotalLength();
				for (let k = 0; k < 48; k++) {
					if (into.isPointInFill(from.getPointAtLength((length * k) / 48))) return true;
				}
				return false;
			};
			for (let i = 0; i < outlines.length; i++) {
				for (let j = i + 1; j < outlines.length; j++) {
					if (inside(outlines[i], outlines[j]) || inside(outlines[j], outlines[i])) subOverlaps++;
				}
			}
		}
		return {
			collisions,
			subOverlaps,
			detail,
			tiesUnderNames,
			names: names.length,
			ties: ties.length
		};
	});
}

async function checkStates(page: Page, deptId: string, roleId: string): Promise<void> {
	const states = {
		ungrouped: '/mapping',
		grouped: `/mapping?group=${deptId}`,
		subgrouped: `/mapping?group=${deptId}&sub=${roleId}`
	};
	for (const [state, url] of Object.entries(states)) {
		await page.goto(url);
		await waitForMapReady(page);
		await expect(page.locator('svg g[role="button"][data-node-id]')).toHaveCount(50);
		const counts = await settled(() => measure(page));
		await test.info().attach(`label-collisions-${state}.json`, {
			body: JSON.stringify(counts, null, 2),
			contentType: 'application/json'
		});
		expect.soft(counts.collisions, `${state}: ${JSON.stringify(counts)}`).toBe(0);
	}
}

// Randomly minted IDs changed the layout on every run despite a fixed topology seed.
// The browser regression gate uses the complete captured inputs below instead.

// Captured from a real failing run, including the identities that influence layout.
// Replaying the read boundary preserves those inputs without changing ID generation.
// The other captures and the arithmetic of the same rules are unit-tested on the
// same fixtures in map-label-clearance.spec.ts.
test(`captured seed ${collision11.seedValue} names clear region headings and other dots`, async ({
	page
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.route('**/api/dataset', (route) => route.fulfill({ json: collision11.dataset }));
	await checkStates(page, collision11.deptId, collision11.roleId);
});

// A Free name stands within 32 screen pixels of its dot's surface; one that had to leave
// that reach (to clear a dot, a name or reserved text) must draw a leader to its own dot.
test(`captured dot overlap ${collisionDotUngrouped.seedValue} Free names stay within 32px or draw a leader`, async ({
	page
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.route('**/api/dataset', (route) =>
		route.fulfill({ json: collisionDotUngrouped.dataset })
	);
	await page.goto('/mapping');
	await waitForMapReady(page);
	const names = await settled(() =>
		page.evaluate(() => {
			const surface = document.querySelector('[data-testid="relationship-map-surface"]')!;
			const leaders = new Set(
				[...surface.querySelectorAll<SVGLineElement>('line[data-name-leader]')].map(
					(line) => line.dataset.nameLeader!
				)
			);
			return [...surface.querySelectorAll<SVGTextElement>('text[data-node-label]')].map((text) => {
				const id = text.dataset.nodeLabel!;
				const circle = surface.querySelector<SVGCircleElement>(
					`g[data-node-id="${id}"] circle:not(.fill-none):not([data-hit-for])`
				)!;
				const t = text.getBoundingClientRect();
				const c = circle.getBoundingClientRect();
				const cx = (c.left + c.right) / 2;
				const cy = (c.top + c.bottom) / 2;
				const x = Math.max(t.left, Math.min(cx, t.right));
				const y = Math.max(t.top, Math.min(cy, t.bottom));
				return {
					id,
					standoff: Math.hypot(x - cx, y - cy) - c.width / 2,
					leader: leaders.has(id)
				};
			});
		})
	);
	expect(names.length, 'names are shown').toBeGreaterThan(0);
	for (const name of names)
		if (name.standoff > 32.5)
			expect(name.leader, `${name.id} stands ${Math.round(name.standoff)}px off`).toBe(true);
});
