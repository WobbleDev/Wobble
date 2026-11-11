import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './fixtures.ts';
import { settled, waitForMapReady } from './map.ts';
import { scoreLayoutQuality } from '../src/lib/features/mapping/layout/graph-layout-quality.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

test.skip(process.env.CAPTURE_LAYOUT_BASELINE !== '1', 'one-time layout quality capture');
test.use({ reducedMotion: 'reduce', viewport: { width: 1600, height: 1000 } });

test('saves rendered Free, Grouped and nested synthetic baseline views', async ({
	page,
	request,
	activeWorksite
}) => {
	const departmentId = '10000000-0000-4000-8000-000000000001';
	const roleId = '10000000-0000-4000-8000-000000000002';
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{
				id: departmentId,
				name: 'Department',
				kind: 'category',
				options: ['D1', 'D2', 'D3', 'D4', 'D5']
			},
			{ id: roleId, name: 'Role', kind: 'category', options: ['R1', 'R2', 'R3', 'R4'] }
		])
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const memberships: string[] = [];
	const names = Array.from({ length: 60 }, (_, index) => `Synthetic Worker ${index + 1}`);
	for (let index = 0; index < names.length; index += 1) {
		const created = await request.post('/api/workers', {
			data: {
				name: names[index],
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({
					[departmentId]: `D${Math.floor(index / 12) + 1}`,
					[roleId]: `R${(Math.floor(index / 3) % 4) + 1}`
				}),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		const createdWorker = (await created.json()).worker as { id: string; name: string };
		expect(createdWorker.name).toBe(names[index]);
		expect(createdWorker.id).toBeTruthy();
		memberships.push(createdWorker.id);
	}
	const byCommunity: string[][] = [];
	let offset = 0;
	for (const size of [8, 8, 8, 8, 7, 7, 7, 7]) {
		byCommunity.push(memberships.slice(offset, offset + size));
		offset += size;
	}
	const relationships = Array.from({ length: memberships.length }, () => new Set<string>());
	const add = (first: number, second: number) => {
		relationships[first].add(memberships[second]);
		relationships[second].add(memberships[first]);
	};
	for (const community of byCommunity) {
		for (let index = 0; index < community.length; index += 1) {
			const first = memberships.indexOf(community[index]);
			add(first, memberships.indexOf(community[(index + 1) % community.length]));
			add(first, memberships.indexOf(community[(index + 2) % community.length]));
		}
	}
	for (let index = 0; index < byCommunity.length; index += 1) {
		const here = byCommunity[index];
		const next = byCommunity[(index + 1) % byCommunity.length];
		add(memberships.indexOf(here[0]), memberships.indexOf(next[0]));
		add(
			memberships.indexOf(here[Math.floor(here.length / 2)]),
			memberships.indexOf(next[Math.floor(next.length / 2)])
		);
	}
	for (let index = 0; index < memberships.length; index += 1) {
		const updated = await request.put(`/api/workers/${memberships[index]}`, {
			data: {
				name: names[index],
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: wireWorkerAttributes({
					[departmentId]: `D${Math.floor(index / 12) + 1}`,
					[roleId]: `R${(Math.floor(index / 3) % 4) + 1}`
				}),
				agitations: [],
				languages: [],
				relationships: [...relationships[index]],
				notes: []
			}
		});
		expect(updated.ok(), await updated.text()).toBeTruthy();
	}

	const base = resolve(process.cwd(), '.scratch/mapping-live-directions/baseline');
	const output = resolve(base, 'views');
	mkdirSync(output, { recursive: true });
	const views: Record<string, unknown> = {};
	const semanticById = new Map(
		memberships.map((id, index) => [
			id,
			{
				department: `Department ${Math.floor(index / 12) + 1}`,
				role: `Role ${String.fromCharCode(65 + (Math.floor(index / 3) % 4))}`
			}
		])
	);
	for (const [form, suffix] of [
		['free', ''],
		['grouped', `?group=${departmentId}`],
		['nested', `?group=${departmentId}&sub=${roleId}`]
	] as const) {
		for (const [aspect, viewport] of [
			['wide', { width: 1600, height: 1000 }],
			['tall', { width: 1000, height: 1400 }],
			['floor', { width: 1024, height: 640 }]
		] as const) {
			await page.setViewportSize(viewport);
			await page.goto(`/mapping${suffix}`);
			await waitForMapReady(page);
			await page.evaluate(() => document.fonts.ready.then(() => undefined));
			await expect(page.locator('svg g[role="button"][data-node-id]')).toHaveCount(60);
			const name = `${form}-${aspect}`;
			const capture = () =>
				page.evaluate(() => {
					const surface = document.querySelector<HTMLElement>(
						'[data-testid="relationship-map-canvas"]'
					)!;
					const layer = document.querySelector<SVGGElement>(
						'[data-testid="relationship-map-layer"]'
					)!;
					const box = (element: Element | null) => {
						if (!element) return null;
						const rect = element.getBoundingClientRect();
						return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
					};
					const canvas = box(surface)!;
					const screenMatrix = layer.getScreenCTM()!;
					const floating = innerWidth >= 1024;
					const controlStrip = box(document.querySelector('[data-testid="mapping-control-strip"]'));
					const bottomBar = box(document.querySelector('[data-testid="mapping-bottom-bar"]'));
					const insets = {
						top: floating ? (controlStrip?.height ?? 0) : 0,
						right: 0,
						bottom: floating ? (bottomBar?.height ?? 0) : 0,
						left: 0
					};
					return {
						viewport: { width: innerWidth, height: innerHeight },
						canvas,
						controlStrip,
						bottomBar,
						freeCanvas: {
							x: canvas.x + insets.left,
							y: canvas.y + insets.top,
							width: Math.max(0, canvas.width - insets.left - insets.right),
							height: Math.max(0, canvas.height - insets.top - insets.bottom)
						},
						cameraTransform: layer.getAttribute('transform'),
						screenTransform: {
							a: screenMatrix.a,
							b: screenMatrix.b,
							c: screenMatrix.c,
							d: screenMatrix.d,
							e: screenMatrix.e,
							f: screenMatrix.f
						},
						workers: [...surface.querySelectorAll<SVGGElement>('[data-node-id]')].map((node) => {
							const id = node.dataset.nodeId!;
							const dot = node.querySelector<SVGCircleElement>(
								'circle:not(.fill-none):not([data-hit-for])'
							);
							const label = surface.querySelector<SVGTextElement>('[data-node-label="' + id + '"]');
							const visibleLabel = label
								? [...label.childNodes]
										.filter((child) => child.nodeType === Node.TEXT_NODE)
										.map((child) => child.textContent)
										.join('')
										.trim()
								: undefined;
							const labelRect = label?.getBBox();
							const labelScreenRect = label?.getBoundingClientRect();
							const dotScreenRect = dot?.getBoundingClientRect();
							return {
								id,
								labelShown: Boolean(label),
								label: visibleLabel,
								labelBox: labelRect
									? {
											x: labelRect.x,
											y: labelRect.y,
											width: labelRect.width,
											height: labelRect.height
										}
									: undefined,
								labelScreenBox: labelScreenRect
									? {
											x: labelScreenRect.x,
											y: labelScreenRect.y,
											width: labelScreenRect.width,
											height: labelScreenRect.height
										}
									: undefined,
								labelFont: label
									? {
											size: getComputedStyle(label).fontSize,
											family: getComputedStyle(label).fontFamily,
											weight: getComputedStyle(label).fontWeight
										}
									: undefined,
								dot: dot
									? {
											x: dotScreenRect!.x + dotScreenRect!.width / 2,
											y: dotScreenRect!.y + dotScreenRect!.height / 2,
											radius: Math.min(dotScreenRect!.width, dotScreenRect!.height) / 2,
											mapX: dot.getAttribute('cx'),
											mapY: dot.getAttribute('cy'),
											mapRadius: dot.getAttribute('r')
										}
									: null
							};
						}),
						regions: [...surface.querySelectorAll<SVGGElement>('[data-group-hull]')].map(
							(group) => ({
								key: group.dataset.groupHull,
								hulls: [...group.querySelectorAll<SVGPathElement>(':scope > path')].map((path) => {
									const bounds = path.getBBox();
									const screen = path.getBoundingClientRect();
									return {
										d: path.getAttribute('d'),
										bounds: {
											x: bounds.x,
											y: bounds.y,
											width: bounds.width,
											height: bounds.height
										},
										screenBounds: {
											x: screen.x,
											y: screen.y,
											width: screen.width,
											height: screen.height
										}
									};
								}),
								subRegionHulls: [...group.querySelectorAll<SVGPathElement>('path.fill-chip')].map(
									(path) => {
										const bounds = path.getBBox();
										const screen = path.getBoundingClientRect();
										return {
											d: path.getAttribute('d'),
											bounds: {
												x: bounds.x,
												y: bounds.y,
												width: bounds.width,
												height: bounds.height
											},
											screenBounds: {
												x: screen.x,
												y: screen.y,
												width: screen.width,
												height: screen.height
											}
										};
									}
								)
							})
						),
						regionLabels: [...surface.querySelectorAll<SVGTextElement>('[data-region-label]')].map(
							(label) => {
								const bounds = label.getBoundingClientRect();
								return {
									key: label.dataset.regionLabel,
									text: label.textContent?.trim(),
									fontSize: getComputedStyle(label).fontSize,
									fontFamily: getComputedStyle(label).fontFamily,
									bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
								};
							}
						),
						tieCount: surface.querySelectorAll('[data-tie]').length,
						renderedPaths: [...surface.querySelectorAll<SVGPathElement>('[data-tie]')].map(
							(path) => ({
								tie: path.dataset.tie,
								d: path.getAttribute('d'),
								strokeWidth: path.getAttribute('stroke-width')
							})
						)
					};
				});
			views[name] = await settled(capture);
			const rendered = views[name] as {
				freeCanvas: { x: number; y: number; width: number; height: number };
				workers: {
					id: string;
					dot: {
						x: number;
						y: number;
						radius: number;
						mapX: string;
						mapY: string;
						mapRadius: string;
					};
					labelScreenBox?: { x: number; y: number; width: number; height: number };
				}[];
			};
			const canvasBox = rendered.freeCanvas;
			const positions = new Map(
				rendered.workers.map(({ id, dot }) => [
					id,
					{ x: dot.x - canvasBox.x, y: dot.y - canvasBox.y }
				])
			);
			const radii = new Map(rendered.workers.map(({ id, dot }) => [id, dot.radius]));
			const footprints = rendered.workers.flatMap(({ id, dot, labelScreenBox }) => [
				{
					kind: 'circle' as const,
					x: positions.get(id)!.x,
					y: positions.get(id)!.y,
					radius: dot.radius
				},
				...(labelScreenBox
					? [
							{
								kind: 'rect' as const,
								x: labelScreenBox.x - canvasBox.x,
								y: labelScreenBox.y - canvasBox.y,
								width: labelScreenBox.width,
								height: labelScreenBox.height
							}
						]
					: [])
			]);
			const groupOf = new Map(memberships.map((id) => [id, semanticById.get(id)!.department]));
			const subGroupOf = new Map(
				memberships.map((id) => [
					id,
					semanticById.get(id)!.department + ' / ' + semanticById.get(id)!.role
				])
			);
			const groups = [...new Set(groupOf.values())];
			const subGroups = [...new Set(subGroupOf.values())];
			const bodyList = (keys: string[], partition: ReadonlyMap<string, string>) =>
				keys.map((id) => ({
					id,
					members: [...partition].filter(([, key]) => key === id).map(([workerId]) => workerId)
				}));
			const partitions =
				form === 'free' ? [] : form === 'grouped' ? [groupOf] : [groupOf, subGroupOf];
			const quality = scoreLayoutQuality({
				positions,
				links: memberships.flatMap((source, index) =>
					[...relationships[index]]
						.filter((target) => source < target)
						.map((target, linkIndex) => ({ id: source + '-' + linkIndex, source, target }))
				),
				bodies:
					form === 'free'
						? []
						: [
								...bodyList(groups, groupOf),
								...(form === 'nested' ? bodyList(subGroups, subGroupOf) : [])
							],
				outwardPartitions: partitions,
				canvas: { width: canvasBox.width, height: canvasBox.height },
				radii,
				footprints,
				sampleSize: 4
			});
			await page.screenshot({ path: resolve(output, `${name}.png`) });
			await page.reload();
			await waitForMapReady(page);
			await page.evaluate(() => document.fonts.ready.then(() => undefined));
			expect(await settled(capture), `repeated renderer geometry for ${name}`).toEqual(views[name]);
			(views[name] as Record<string, unknown>).quality = quality;
		}
	}
	writeFileSync(
		resolve(base, 'renderer-capture.json'),
		`${JSON.stringify(
			{
				sourceRevision: process.env.BASELINE_SOURCE_REVISION ?? 'record with git rev-parse HEAD',
				worksite: activeWorksite,
				identities: {
					workers: memberships.map((id, index) => ({
						semanticId: `synthetic-${String(index + 1).padStart(2, '0')}`,
						id,
						name: names[index],
						department: `Department ${Math.floor(index / 12) + 1}`,
						role: `Role ${String.fromCharCode(65 + (Math.floor(index / 3) % 4))}`
					})),
					departmentId,
					roleId,
					relationships: memberships.flatMap((source, index) =>
						[...relationships[index]]
							.filter((target) => source < target)
							.map((target) => ({ source, target }))
					)
				},
				rendering: {
					relationshipsAreStraightSegments: true,
					pathDescription:
						'the live renderer emits M x y L x y; this artifact does not claim curved-route clearance'
				},
				sourceTree: {
					revision: process.env.BASELINE_SOURCE_REVISION ?? 'record with git rev-parse HEAD',
					state:
						'working tree contains only ticket capture/evaluator changes; no production source or geometry changes',
					historicalBaselinePreserved: true
				},
				views
			},
			null,
			2
		)}\n`
	);
});
