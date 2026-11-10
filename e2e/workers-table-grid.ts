import { randomUUID } from 'node:crypto';
import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, isReplay } from './fixtures.ts';
import {
	contentColumnRem,
	nameColumnRem,
	workersColumnMinRem
} from '../src/lib/features/workers/data-table/workers-table-width.ts';
import { wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';

/** The density cases the Workers table is measured at, and what each renders. */
export const densityCases = [
	{ name: 'Standard', value: 'standard', rootFont: '16px', line: 44, oneLineFrom: 1280 },
	{ name: 'Compact', value: 'compact', rootFont: '15px', line: 41, oneLineFrom: 1280 },
	// Comfortable is a sixteenth larger while the frame stays the same, so at
	// 1280px it cannot hold every value of the seeded Worksite and the Attribute
	// cells wrap there instead of hiding one.
	{ name: 'Comfortable', value: 'comfortable', rootFont: '17px', line: 47, oneLineFrom: 1440 }
] as const;

const attributeDefs = [
	{
		name: 'Department',
		kind: 'category' as const,
		options: ['Front of House', 'Middle of House']
	},
	{ name: 'Role', kind: 'category' as const, options: ['Server', 'Service Assistant'] },
	{ name: 'Shifts', kind: 'tag' as const, options: ['Dinner', 'Brunch'] }
];

const workerNames = [
	'Ada Lovelace',
	'Grace Hopper',
	'Katherine Johnson',
	'Mary Jackson',
	'Annie Easley',
	'Dorothy Vaughan',
	'Margaret Hamilton',
	'Jean Bartik'
];

/** A Worksite's worth of workers: three Attributes, three Languages, eight names. */
export async function seedWorkers(request: APIRequestContext) {
	if (isReplay) return;
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions(attributeDefs.map((attribute) => ({ ...attribute, id: randomUUID() })))
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const { attributes }: { attributes: { id: string }[] } = await configured.json();

	const languages: string[] = [];
	for (const name of ['Spanish', 'Polish', 'Vietnamese']) {
		// Creating a Language is idempotent: an existing name comes back with it.
		const created = await request.post('/api/languages', { data: { name } });
		expect(created.ok(), await created.text()).toBeTruthy();
		const { language }: { language: { id: string } } = await created.json();
		languages.push(language.id);
	}

	for (const [index, name] of workerNames.entries()) {
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Supporter',
				attributes: wireWorkerAttributes({
					[attributes[0].id]: attributeDefs[0].options[index % 2],
					[attributes[1].id]: attributeDefs[1].options[index % 2],
					[attributes[2].id]: [attributeDefs[2].options[0], attributeDefs[2].options[1]]
				}),
				agitations: [],
				languages: languages.slice(0, (index % 2) + 1),
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}
}

/** One Category with `count` values and one Worker per value. */
export async function seedManyCategories(request: APIRequestContext, count = 40) {
	const categoryId = randomUUID();
	const options = Array.from({ length: count }, (_, index) => `Department ${index + 1}`);
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions([{ id: categoryId, name: 'Department', kind: 'category', options }])
	});
	expect(configured.ok()).toBeTruthy();

	for (const value of options) {
		const created = await request.post('/api/workers', {
			data: {
				name: `Worker ${value}`,
				email: '',
				phone: '',
				assessment: 'Supporter',
				attributes: wireWorkerAttributes({ [categoryId]: value }),
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}

	return { categoryId };
}

/** Twelve Attributes — six Categories and six two-value Tags — for the wide-layout suite. */
const wideAttributeDefs = [
	{
		name: 'Department',
		kind: 'category' as const,
		options: ['Front of House', 'Middle of House', 'Back of House']
	},
	{ name: 'Role', kind: 'category' as const, options: ['Server', 'Service Assistant', 'Cook'] },
	{ name: 'Station', kind: 'category' as const, options: ['North', 'South', 'East', 'West'] },
	{ name: 'Shift lead', kind: 'category' as const, options: ['Day', 'Night'] },
	{ name: 'Mentor', kind: 'category' as const, options: ['Yes', 'No'] },
	{ name: 'Crew', kind: 'category' as const, options: ['Alpha', 'Beta', 'Gamma'] },
	{ name: 'Shifts', kind: 'tag' as const, options: ['Dinner', 'Brunch'] },
	{ name: 'Skills', kind: 'tag' as const, options: ['Bar', 'Floor'] },
	{ name: 'Certifications', kind: 'tag' as const, options: ['First aid', 'Food safety'] },
	{ name: 'Zones', kind: 'tag' as const, options: ['Patio', 'Counter'] },
	{ name: 'Programs', kind: 'tag' as const, options: ['Outreach', 'Training'] },
	{ name: 'Duties', kind: 'tag' as const, options: ['Opening', 'Closing'] }
];

const wideLanguageNames = ['Spanish', 'Polish', 'Vietnamese'];

const wideFirstNames = [
	'Ada',
	'Grace',
	'Katherine',
	'Mary',
	'Annie',
	'Dorothy',
	'Margaret',
	'Jean',
	'Radia',
	'Hedy',
	'Mae',
	'Chien',
	'Tu',
	'Gladys',
	'Flossie',
	'Virginia'
];
const wideLastNames = [
	'Lovelace',
	'Hopper',
	'Johnson',
	'Jackson',
	'Easley',
	'Vaughan',
	'Hamilton',
	'Bartik'
];

/**
 * The name `seedWideWorkers` gives its index-th Worker. The trailing number is
 * what makes it unique: first and last names repeat across the fifty, so a spec
 * must name a Worker exactly rather than matching on the first two words.
 */
export function wideWorkerName(index: number): string {
	return `${wideFirstNames[index % wideFirstNames.length]} ${wideLastNames[(index * 5) % wideLastNames.length]} ${index + 1}`;
}

/** Fifty Workers under twelve Attributes: the floor/viewport/scrollport fixture. */
export async function seedWideWorkers(request: APIRequestContext) {
	const configured = await request.put('/api/attributes', {
		data: wireDefinitions(
			wideAttributeDefs.map((attribute) => ({ ...attribute, id: randomUUID() }))
		)
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();
	const { attributes }: { attributes: { id: string }[] } = await configured.json();

	const languages: string[] = [];
	for (const name of wideLanguageNames) {
		const created = await request.post('/api/languages', { data: { name } });
		expect(created.ok(), await created.text()).toBeTruthy();
		const { language }: { language: { id: string } } = await created.json();
		languages.push(language.id);
	}

	for (let index = 0; index < 50; index += 1) {
		const name = wideWorkerName(index);
		const values: Record<string, string | string[]> = {};
		wideAttributeDefs.forEach((def, defIndex) => {
			const id = attributes[defIndex].id;
			if (def.kind === 'category') {
				values[id] = def.options[(index + defIndex) % def.options.length];
			} else {
				values[id] =
					index % 2 === 0
						? [...def.options]
						: [def.options[(index + defIndex) % def.options.length]];
			}
		});
		const created = await request.post('/api/workers', {
			data: {
				name,
				email: '',
				phone: '',
				assessment: 'Supporter',
				attributes: wireWorkerAttributes(values),
				agitations: [],
				languages: languages.slice(0, (index % 2) + 1),
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
	}
}

/**
 * The Name column's width for the standard fixture, in rem: Name is pinned to
 * its longest seeded name by the app's own rule (workers-table-width.ts), not a
 * fixed breakpoint length.
 */
export function workersNameRem(): number {
	return nameColumnRem(workerNames);
}

/**
 * The narrowest the standard fixture's table can be, in rem: the pinned checkbox
 * (2.75), Name (its longest name), Assessment (9),
 * plus Languages and every Attribute sized to their content by the app's own rule.
 */
export function workersFloorRem(): number {
	const fixed = 2.75 + nameColumnRem(workerNames) + 9;
	const languages = contentColumnRem(['Spanish', 'Polish', 'Vietnamese']);
	const attributes = attributeDefs.reduce(
		(sum, attribute) => sum + contentColumnRem(attribute.options),
		0
	);
	return fixed + languages + attributes;
}

/**
 * The scroll floor for the standard fixture, in rem: the pinned columns plus
 * every shrinkable column at its minimum (Assessment 6, content at most 5).
 * Below this sum the scrollport scrolls; above it the columns shrink instead.
 */
export function workersMinFloorRem(): number {
	const fixed = 2.75 + nameColumnRem(workerNames) + workersColumnMinRem('assessment', 9);
	const languages = workersColumnMinRem(
		'languages',
		contentColumnRem(['Spanish', 'Polish', 'Vietnamese'])
	);
	const attributes = attributeDefs.reduce(
		(sum, attribute) =>
			sum + workersColumnMinRem(attribute.name, contentColumnRem(attribute.options)),
		0
	);
	return fixed + languages + attributes;
}

/**
 * The narrowest the twelve-Attribute table can be, in rem: the pinned checkbox
 * (2.75), Name (its longest seeded name), Assessment (9), plus Languages and every Attribute sized to their content from the
 * seeds above, by the app's own content rule.
 */
export function wideWorkersFloorRem(): number {
	const names = Array.from({ length: 50 }, (_, index) => wideWorkerName(index));
	const fixed = 2.75 + nameColumnRem(names) + 9;
	const languages = contentColumnRem(wideLanguageNames);
	const attributes = wideAttributeDefs.reduce(
		(sum, attribute) => sum + contentColumnRem(attribute.options),
		0
	);
	return fixed + languages + attributes;
}

/** The scroll floor for the twelve-Attribute fixture: pinned columns plus shrink minima. */
export function wideWorkersMinFloorRem(): number {
	const names = Array.from({ length: 50 }, (_, index) => wideWorkerName(index));
	const fixed = 2.75 + nameColumnRem(names) + workersColumnMinRem('assessment', 9);
	const languages = workersColumnMinRem('languages', contentColumnRem(wideLanguageNames));
	const attributes = wideAttributeDefs.reduce(
		(sum, attribute) =>
			sum + workersColumnMinRem(attribute.name, contentColumnRem(attribute.options)),
		0
	);
	return fixed + languages + attributes;
}

/** The Workers table's own measurements, taken from the rendered grid. */
export async function gridReport(page: Page) {
	return page.evaluate(() => {
		const viewport = document.querySelector<HTMLElement>('[data-testid="workers-scroll-viewport"]');
		if (!viewport) throw new Error('The Workers table viewport is missing.');

		const headers = [...viewport.querySelectorAll('thead th')];
		const workerRows = [...viewport.querySelectorAll('tbody tr[data-index]')];
		const label = (th: Element) => (th.textContent ?? '').trim() || 'select';
		const box = (cell: Element) => {
			const rect = cell.getBoundingClientRect();
			return { x: Math.round(rect.x), width: Math.round(rect.width) };
		};

		const firstRow = workerRows[0];

		const table = viewport.querySelector('table[data-slot="table"]');

		return {
			widths: headers.map((th) => ({ label: label(th), ...box(th) })),
			cells: firstRow ? [...firstRow.querySelectorAll('td')].map(box) : [],
			rowHeights: workerRows.map((row) => Math.round(row.getBoundingClientRect().height)),
			rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
			overflowX: viewport.scrollWidth > viewport.clientWidth + 1,
			viewportWidth: viewport.clientWidth,
			viewportOffsetWidth: viewport.offsetWidth,
			viewportScrollWidth: viewport.scrollWidth,
			viewportScrollLeft: viewport.scrollLeft,
			maxScrollLeft: viewport.scrollWidth - viewport.clientWidth,
			endGap: viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft,
			computedOverflowX: getComputedStyle(viewport).overflowX,
			tableScrollWidth: table ? table.scrollWidth : 0,
			documentOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1
		};
	});
}

export type GridReport = Awaited<ReturnType<typeof gridReport>>;

export const widthOf = (report: GridReport, label: string): number =>
	report.widths.find((column) => column.label === label)?.width ?? 0;

export const valueColumns = (report: GridReport) =>
	report.widths.filter((column) => !['select', 'Name'].includes(column.label));
