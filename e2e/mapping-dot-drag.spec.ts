import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures.ts';
import { waitForMapInteraction } from './map.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

test.use({ reducedMotion: 'reduce' });

const base = {
	email: '',
	phone: '',
	assessment: 'Unassessed',
	agitations: [],
	languages: [],
	notes: []
};

test('dragging a dot moves only that dot, not its neighbours', async ({ page, request }) => {
	const deptId = randomUUID();
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([
			{ id: deptId, name: 'Department', kind: 'category', options: ['Front of House'] }
		])
	});
	expect(configured.ok()).toBeTruthy();
	const attributes = wireWorkerAttributes({ [deptId]: 'Front of House' });
	const names = ['Ada', 'Bo', 'Cy', 'Fio', 'Gus', 'Hana'];
	const ids: string[] = [];
	for (const name of names) {
		const created = await request.post('/api/workers', {
			data: { ...base, attributes, name, relationships: [] }
		});
		expect(created.status(), await created.text()).toBe(201);
		ids.push((await created.json()).worker.id);
	}
	const related = await request.put(`/api/workers/${ids[0]}`, {
		data: { ...base, attributes, name: 'Ada', relationships: [ids[1], ids[2]] }
	});
	expect(related.ok(), await related.text()).toBeTruthy();

	await page.setViewportSize({ width: 1400, height: 800 });
	await page.goto('/mapping');
	await expect(page.locator('svg g[role="button"][data-node-id]')).toHaveCount(6);
	await waitForMapInteraction(page);

	const centre = async (id: string) => {
		const box = (await page.locator(`circle[data-hit-for="${id}"]`).boundingBox())!;
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	};

	const before = await Promise.all(ids.map(centre));
	await page.mouse.move(before[0].x, before[0].y);
	await page.mouse.down();
	await page.mouse.move(before[0].x + 60, before[0].y + 40, { steps: 8 });
	await page.mouse.up();
	await expect(page.getByTestId('relationship-map-surface')).toHaveAttribute(
		'data-manual-revision',
		'1'
	);
	const after = await Promise.all(ids.map(centre));

	expect(after[0].x - before[0].x).toBeGreaterThan(40);
	// The dragged dot's related Workers (1, 2) and the others stay exactly where they were.
	for (const index of [1, 2, 3, 4, 5]) {
		expect(after[index].x).toBeCloseTo(before[index].x, 0);
		expect(after[index].y).toBeCloseTo(before[index].y, 0);
	}
});
