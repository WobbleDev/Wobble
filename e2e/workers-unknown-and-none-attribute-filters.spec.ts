import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test, testId } from './fixtures.ts';
import { openWorkers } from './pages.ts';
import { appReady } from './page-ready.ts';
import { answerId, wireDefinitions, wireWorkerAttributes } from './answer-wire.ts';
import { addAgitations, addAttributes, addLanguages, addWorkers } from './worksite-builder.ts';

/**
 * Ticket 06: the Workers filters read ordinary Worker Attributes. Every Attribute is
 * evaluated independently, a parent selection includes its descendants, a missing
 * value is "No <current Attribute name>" for either cardinality, and the retired
 * legacy URL key normalizes away without losing unrelated URL state.
 *
 * Fixture (the specification's Ada/Bea/Cy conversion, widened):
 * - Location: Multi-Select, Central > Store A > Packing, Central > Store B, North Store.
 * - Job: Multi-Select, Cashier, Stocker, and a real answer literally named "No Job".
 * - Shift: Single-Select, Days, Nights.
 * - Team: Single-Select, Team A, Team B, and a real answer "No work assignments".
 *
 * - Ada: Store A + Store B, Cashier + Stocker, Days, Team A.
 * - Bea: Store A, Cashier, Nights, Team A.
 * - Casey: Packing (under Store A), Stocker, Days, Team A.
 * - Cy: nothing, Team B.
 * - Frankie: Store B, no Job, Days, Team A.
 * - Harper: Store B, the real "No Job" answer, Days, Team B.
 * - Kai: Store B, Stocker, no Shift, Team B.
 * - Gray: nothing, Team B.
 * - Dana: North Store, Stocker, Days, Team B.
 */

type Seeded = {
	ids: { location: string; job: string; shift: string; team: string };
	answers: {
		central: string;
		storeA: string;
		storeB: string;
		packing: string;
		northStore: string;
		cashier: string;
		stocker: string;
		noJob: string;
		days: string;
		nights: string;
		teamA: string;
		teamB: string;
		noAssignments: string;
	};
	workers: Record<string, string>;
};

const ALL_NAMES = [
	'Charles Darwin',
	'Johannes Kepler',
	'Edith Clarke',
	'Ada Lovelace',
	'Louis Pasteur',
	'Carl Sagan',
	'Barbara McClintock',
	'Gregor Mendel',
	'Member 13'
];

const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');
const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
const count = (page: Page) => page.getByTestId('worker-count');
const active = (page: Page) => page.getByTestId('active-condition');

async function seed(request: APIRequestContext): Promise<Seeded> {
	const location = 'location-' + testId();
	const job = 'job-' + testId();
	const shift = 'shift-' + testId();
	const team = 'team-' + testId();
	const answers = {
		central: answerId(location, 'Central'),
		storeA: answerId(location, 'Store A'),
		storeB: answerId(location, 'Store B'),
		packing: answerId(location, 'Packing'),
		northStore: answerId(location, 'North Store'),
		cashier: answerId(job, 'Cashier'),
		stocker: answerId(job, 'Stocker'),
		noJob: answerId(job, 'No Job'),
		days: answerId(shift, 'Days'),
		nights: answerId(shift, 'Nights'),
		teamA: answerId(team, 'Team A'),
		teamB: answerId(team, 'Team B'),
		noAssignments: answerId(team, 'No work assignments')
	};

	const configured = await request.put('/api/attributes', {
		data: [
			{
				id: location,
				name: 'Location',
				kind: 'tag',
				options: [
					{ id: answers.central, value: 'Central' },
					{ id: answers.storeA, value: 'Store A', parentId: answers.central },
					{ id: answers.packing, value: 'Packing', parentId: answers.storeA },
					{ id: answers.storeB, value: 'Store B', parentId: answers.central },
					{ id: answers.northStore, value: 'North Store' }
				]
			},
			{
				id: job,
				name: 'Job',
				kind: 'tag',
				options: [
					{ id: answers.cashier, value: 'Cashier' },
					{ id: answers.stocker, value: 'Stocker' },
					{ id: answers.noJob, value: 'No Job' }
				]
			},
			{
				id: shift,
				name: 'Shift',
				kind: 'category',
				options: [
					{ id: answers.days, value: 'Days' },
					{ id: answers.nights, value: 'Nights' }
				]
			},
			{
				id: team,
				name: 'Team',
				kind: 'category',
				options: [
					{ id: answers.teamA, value: 'Team A' },
					{ id: answers.teamB, value: 'Team B' },
					{ id: answers.noAssignments, value: 'No work assignments' }
				]
			}
		]
	});
	expect(configured.ok(), await configured.text()).toBeTruthy();

	const people: Array<{
		name: string;
		location: string[];
		job: string[];
		shift: string;
		team: string;
	}> = [
		{
			name: 'Ada Lovelace',
			location: [answers.storeA, answers.storeB],
			job: [answers.cashier, answers.stocker],
			shift: answers.days,
			team: answers.teamA
		},
		{
			name: 'Edith Clarke',
			location: [answers.storeA],
			job: [answers.cashier],
			shift: answers.nights,
			team: answers.teamA
		},
		{
			name: 'Carl Sagan',
			location: [answers.packing],
			job: [answers.stocker],
			shift: answers.days,
			team: answers.teamA
		},
		{ name: 'Member 13', location: [], job: [], shift: '', team: answers.teamB },
		{
			name: 'Johannes Kepler',
			location: [answers.storeB],
			job: [],
			shift: answers.days,
			team: answers.teamA
		},
		{
			name: 'Louis Pasteur',
			location: [answers.storeB],
			job: [answers.noJob],
			shift: answers.days,
			team: answers.noAssignments
		},
		{
			name: 'Gregor Mendel',
			location: [answers.storeB],
			job: [answers.stocker],
			shift: '',
			team: answers.teamB
		},
		{ name: 'Charles Darwin', location: [], job: [], shift: '', team: answers.teamB },
		{
			name: 'Barbara McClintock',
			location: [answers.northStore],
			job: [answers.stocker],
			shift: answers.days,
			team: answers.teamB
		}
	];

	const workers: Record<string, string> = {};
	for (const person of people) {
		const created = await request.post('/api/workers', {
			data: {
				name: person.name,
				email: '',
				phone: '',
				assessment: 'Unassessed',
				attributes: {
					[location]: person.location,
					[job]: person.job,
					[shift]: person.shift,
					[team]: person.team
				},
				agitations: [],
				languages: [],
				relationships: [],
				notes: []
			}
		});
		expect(created.status(), await created.text()).toBe(201);
		workers[person.name] = ((await created.json()) as { worker: { id: string } }).worker.id;
	}

	return {
		ids: { location, job, shift, team },
		answers,
		workers
	};
}

function linkTo(...conditions: Array<[string, string]>): string {
	const params = new URLSearchParams();
	for (const [attributeId, answerId] of conditions)
		params.append('f', attributeId + ':' + answerId);
	return '/workers?' + params.toString();
}

function withMissing(attributeId: string): string {
	return '/workers?missing=' + encodeURIComponent(attributeId);
}

function chosenFilters(page: Page): string[] {
	return new URL(page.url()).searchParams.getAll('f');
}

function chosenMissing(page: Page): string[] {
	return new URL(page.url()).searchParams.getAll('missing');
}

function chosenAssignments(page: Page): string[] {
	return new URL(page.url()).searchParams.getAll('assignments');
}

async function expectNames(page: Page, names: string[], total: number): Promise<void> {
	await expect(rows(page)).toHaveCount(total);
	await expect(count(page)).toHaveText(total === 1 ? '1 worker' : total + ' workers');
	for (const name of names) await expect(row(page, name)).toHaveCount(1);
}

async function openFilter(page: Page, attributeName: string): Promise<void> {
	await page.getByRole('button', { name: `Filter ${attributeName}`, exact: true }).click();
}

async function openFiltersMenu(page: Page): Promise<void> {
	await page.getByRole('button', { name: /^Filters/ }).focus();
	await page.keyboard.press('Enter');
}

async function chooseInSubmenu(page: Page, group: string, option: string | RegExp): Promise<void> {
	await page.getByRole('menuitem', { name: new RegExp('^' + group) }).click();
	await page
		.getByRole('menuitemcheckbox', { name: option, exact: typeof option === 'string' })
		.click();
}

async function closeMenus(page: Page): Promise<void> {
	while ((await page.getByRole('menu').count()) > 0) await page.keyboard.press('Escape');
}

const NO_JOB_READING = /^No Job \(No selection\)$/;

test('@ticket-06 filters on different Attributes independently, so Ada matches Store B with Cashier', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openWorkers(
		page,
		linkTo([seeded.ids.location, seeded.answers.storeB], [seeded.ids.job, seeded.answers.cashier])
	);

	// Ada is the only Worker holding both Store B and Cashier, even though no former
	// pairing linked them; a Store filter never constrains Job.
	await expectNames(page, ['Ada Lovelace'], 1);
	await expect(active(page)).toHaveCount(2);
	expect(chosenFilters(page)).toEqual([
		seeded.ids.location + ':' + seeded.answers.storeB,
		seeded.ids.job + ':' + seeded.answers.cashier
	]);

	// Store B alone finds Ada, Frankie, Harper and Kai; Job Cashier alone finds Ada
	// and Bea (the real "No Job" answer is not Cashier).
	await openWorkers(page, linkTo([seeded.ids.location, seeded.answers.storeB]));
	await expectNames(page, ['Ada Lovelace', 'Johannes Kepler', 'Louis Pasteur', 'Gregor Mendel'], 4);
	await openWorkers(page, linkTo([seeded.ids.job, seeded.answers.cashier]));
	await expectNames(page, ['Ada Lovelace', 'Edith Clarke'], 2);

	// Two values of one Attribute are alternatives, not a conjunction.
	await openWorkers(
		page,
		linkTo([seeded.ids.job, seeded.answers.cashier], [seeded.ids.job, seeded.answers.stocker])
	);
	await expectNames(
		page,
		['Ada Lovelace', 'Edith Clarke', 'Carl Sagan', 'Gregor Mendel', 'Barbara McClintock'],
		5
	);
});

test('@ticket-06 a parent includes its descendants while the exact remainder stays distinguishable', async ({
	page,
	request
}) => {
	const seeded = await seed(request);

	// Central includes Store A, Packing and Store B; North Store is outside it.
	await openWorkers(page, linkTo([seeded.ids.location, seeded.answers.central]));
	await expectNames(
		page,
		[
			'Ada Lovelace',
			'Edith Clarke',
			'Carl Sagan',
			'Johannes Kepler',
			'Louis Pasteur',
			'Gregor Mendel'
		],
		6
	);

	// Store A includes Casey's Packing descendant.
	await openWorkers(page, linkTo([seeded.ids.location, seeded.answers.storeA]));
	await expectNames(page, ['Ada Lovelace', 'Edith Clarke', 'Carl Sagan'], 3);

	// The direct-parent remainder is Store A itself, never its descendants.
	await openWorkers(
		page,
		'/workers?f=' +
			seeded.ids.location +
			':' +
			encodeURIComponent('#self:' + seeded.ids.location + ':' + seeded.answers.storeA)
	);
	await expectNames(page, ['Ada Lovelace', 'Edith Clarke'], 2);
	await expect(row(page, 'Carl Sagan')).toHaveCount(0);
	expect(chosenFilters(page)).toEqual([
		seeded.ids.location + ':#self:' + seeded.ids.location + ':' + seeded.answers.storeA
	]);
	await expect(active(page)).toHaveAttribute('data-exact', 'true');
});

test('@ticket-06 No Job reads empty Multi-Select Job and keeps the real answer by identity', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openWorkers(page, withMissing(seeded.ids.job));

	// Cy, Gray and Frankie hold no Job; Harper's real "No Job" answer is not a missing value.
	await expectNames(page, ['Member 13', 'Charles Darwin', 'Johannes Kepler'], 3);
	await expect(row(page, 'Louis Pasteur')).toHaveCount(0);
	await expect(active(page)).toHaveCount(1);
	await expect(active(page)).toHaveAttribute('data-missing', 'true');
	await expect(active(page).locator('span.font-medium')).toHaveText('No Job');
	await expect(active(page)).toContainText('No selection');
	expect(chosenMissing(page)).toEqual([seeded.ids.job]);

	// Within one Attribute, the system reading and the real answer are alternatives.
	await openFiltersMenu(page);
	await chooseInSubmenu(page, 'Job', 'No Job');
	await closeMenus(page);
	await expectNames(page, ['Member 13', 'Charles Darwin', 'Johannes Kepler', 'Louis Pasteur'], 4);
	await expect(active(page)).toHaveCount(2);

	// Unticking the system reading leaves the real answer alone.
	await openFiltersMenu(page);
	await chooseInSubmenu(page, 'Job', NO_JOB_READING);
	await closeMenus(page);
	await expectNames(page, ['Louis Pasteur'], 1);
	await expect(active(page)).toHaveCount(1);
	await expect(active(page)).not.toHaveAttribute('data-missing', 'true');
	expect(chosenFilters(page)).toEqual([seeded.ids.job + ':' + seeded.answers.noJob]);
	expect(chosenMissing(page)).toEqual([]);

	// A Single-Select empty Shift reads its own "No Shift" group.
	await openWorkers(page, withMissing(seeded.ids.shift));
	await expectNames(page, ['Member 13', 'Charles Darwin', 'Gregor Mendel'], 3);
	await expect(active(page).locator('span.font-medium')).toHaveText('No Shift');
});

test('@ticket-06 a missing link works for either cardinality and follows a renamed Attribute', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openWorkers(page, withMissing(seeded.ids.location));
	await expectNames(page, ['Member 13', 'Charles Darwin'], 2);
	await expect(active(page).locator('span.font-medium')).toHaveText('No Location');

	const renamed = await request.put('/api/attributes', {
		data: [
			{
				id: seeded.ids.location,
				name: 'Territory',
				kind: 'tag',
				options: [
					{ id: seeded.answers.central, value: 'Central' },
					{
						id: seeded.answers.storeA,
						value: 'Store A',
						parentId: seeded.answers.central
					},
					{
						id: seeded.answers.packing,
						value: 'Packing',
						parentId: seeded.answers.storeA
					},
					{
						id: seeded.answers.storeB,
						value: 'Store B',
						parentId: seeded.answers.central
					},
					{ id: seeded.answers.northStore, value: 'North Store' }
				]
			},
			{
				id: seeded.ids.job,
				name: 'Job',
				kind: 'tag',
				options: [
					{ id: seeded.answers.cashier, value: 'Cashier' },
					{ id: seeded.answers.stocker, value: 'Stocker' },
					{ id: seeded.answers.noJob, value: 'No Job' }
				]
			},
			{
				id: seeded.ids.shift,
				name: 'Shift',
				kind: 'category',
				options: [
					{ id: seeded.answers.days, value: 'Days' },
					{ id: seeded.answers.nights, value: 'Nights' }
				]
			},
			{
				id: seeded.ids.team,
				name: 'Team',
				kind: 'category',
				options: [
					{ id: seeded.answers.teamA, value: 'Team A' },
					{ id: seeded.answers.teamB, value: 'Team B' },
					{ id: seeded.answers.noAssignments, value: 'No work assignments' }
				]
			}
		]
	});
	expect(renamed.ok(), await renamed.text()).toBeTruthy();

	await page.reload();
	await appReady(page);
	// The address names the Attribute id, so membership survives; the reading follows it.
	await expectNames(page, ['Member 13', 'Charles Darwin'], 2);
	expect(chosenMissing(page)).toEqual([seeded.ids.location]);
	await expect(active(page).locator('span.font-medium')).toHaveText('No Territory');
});

test('@ticket-06 a retired legacy URL key normalizes away while unrelated state survives', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openWorkers(
		page,
		linkTo([seeded.ids.location, seeded.answers.storeB]) +
			'&assignments=none&missing=deleted-' +
			seeded.ids.job +
			'&worker=' +
			seeded.workers['Ada Lovelace'] +
			'&q=Ada&sel=' +
			seeded.workers['Ada Lovelace']
	);

	// The retired predicate, the stale Attribute and the legacy person parameters are
	// dropped; the valid Store B filter stays and no Worker opens.
	await expectNames(page, ['Ada Lovelace', 'Johannes Kepler', 'Louis Pasteur', 'Gregor Mendel'], 4);
	await expect.poll(() => new URL(page.url()).searchParams.has('assignments')).toBe(false);
	await expect.poll(() => chosenMissing(page)).toEqual([]);
	expect(chosenFilters(page)).toEqual([seeded.ids.location + ':' + seeded.answers.storeB]);
	await expect
		.poll(() => ['worker', 'q', 'sel'].some((key) => new URL(page.url()).searchParams.has(key)))
		.toBe(false);
	await expect(
		page.getByRole('complementary', { name: 'Worker details: Ada Lovelace' })
	).toHaveCount(0);

	// A valid system link and a valid answer link round-trip unchanged.
	await openWorkers(
		page,
		linkTo([seeded.ids.location, seeded.answers.storeB]) + '&missing=' + seeded.ids.job
	);
	await expectNames(page, ['Johannes Kepler'], 1);
	await page.reload();
	await appReady(page);
	await expectNames(page, ['Johannes Kepler'], 1);
	expect(chosenFilters(page)).toEqual([seeded.ids.location + ':' + seeded.answers.storeB]);
	expect(chosenMissing(page)).toEqual([seeded.ids.job]);
});

test('@ticket-06 the no-selection controls remove and clear without touching real answers', async ({
	page,
	request
}) => {
	const seeded = await seed(request);
	await openWorkers(page, withMissing(seeded.ids.job));
	await expectNames(page, ['Member 13', 'Charles Darwin', 'Johannes Kepler'], 3);

	await active(page).getByRole('button', { name: 'Remove No Job (No selection)' }).click();
	await expectNames(page, ALL_NAMES, ALL_NAMES.length);
	expect(chosenMissing(page)).toEqual([]);

	// Team's real "No work assignments" answer is selectable by its own id only.
	await openFiltersMenu(page);
	await chooseInSubmenu(page, 'Team', 'No work assignments');
	await closeMenus(page);
	await expectNames(page, ['Louis Pasteur'], 1);
	await expect(active(page).locator('span.font-medium')).toHaveText('No work assignments');
	await expect(active(page)).not.toHaveAttribute('data-missing', 'true');
	await expect(active(page)).not.toContainText('No selection');

	await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
	await expectNames(page, ALL_NAMES, ALL_NAMES.length);
	expect(chosenAssignments(page)).toEqual([]);
	expect(chosenFilters(page)).toEqual([]);
	await expect(page.getByText('No value', { exact: true })).toHaveCount(0);
});
test.describe('E6 folds product-gap-03 attribute reading', () => {
	type Seeded = {
		departmentId: string;
		rolesId: string;
		workerIds: Record<string, string>;
	};

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const suffix = testId().slice(0, 8);
		const departmentId = `department-${suffix}`;
		const rolesId = `roles-${suffix}`;

		const configured = await request.put('/api/attributes', {
			data: wireDefinitions([
				{
					id: departmentId,
					name: 'Department',
					kind: 'category',
					options: ['Packing', 'Delivery', 'No Department']
				},
				{ id: rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
			])
		});
		expect(configured.ok(), await configured.text()).toBeTruthy();

		const people = [
			{ name: 'Alex', assessment: 'Leader', department: 'Packing', roles: ['Trainer'] },
			{
				name: 'Blair',
				assessment: 'Supporter',
				department: 'Delivery',
				roles: ['Trainer', 'Steward']
			},
			{ name: 'Casey', assessment: 'Unassessed', department: '', roles: [] },
			{ name: 'Drew', assessment: 'Activist', department: 'No Department', roles: [] }
		] as const;

		const workerIds: Record<string, string> = {};
		for (const person of people) {
			const created = await request.post('/api/workers', {
				data: {
					name: person.name,
					email: '',
					phone: '',
					assessment: person.assessment,
					attributes: wireWorkerAttributes({
						[departmentId]: person.department,
						[rolesId]: person.roles
					}),
					agitations: [],
					languages: [],
					relationships: [],
					notes: []
				}
			});
			expect(created.status(), await created.text()).toBe(201);
			workerIds[person.name] = ((await created.json()) as { worker: { id: string } }).worker.id;
		}

		// The fixture's two Relationships, written after every Worker exists.
		await putWorker(request, workerIds.Alex, {
			name: 'Alex',
			assessment: 'Leader',
			attributes: wireWorkerAttributes({ [departmentId]: 'Packing', [rolesId]: ['Trainer'] }),
			relationships: [workerIds.Blair]
		});
		await putWorker(request, workerIds.Blair, {
			name: 'Blair',
			assessment: 'Supporter',
			attributes: wireWorkerAttributes({
				[departmentId]: 'Delivery',
				[rolesId]: ['Trainer', 'Steward']
			}),
			relationships: [workerIds.Alex, workerIds.Casey]
		});

		return { departmentId, rolesId, workerIds };
	}

	/** Replaces one Worker's record; the fixture only needs Relationships to change. */
	async function putWorker(
		request: APIRequestContext,
		id: string,
		worker: {
			name: string;
			assessment: string;
			attributes: Record<string, string | string[]>;
			relationships: string[];
		}
	): Promise<void> {
		const updated = await request.put(`/api/workers/${id}`, {
			data: {
				name: worker.name,
				email: '',
				phone: '',
				assessment: worker.assessment,
				attributes: worker.attributes,
				agitations: [],
				languages: [],
				relationships: worker.relationships,
				notes: []
			}
		});
		expect(updated.ok(), await updated.text()).toBeTruthy();
	}

	/** Renames the Attribute while keeping every answer id, then reloads the view. */
	async function renameDepartmentToTeam(
		request: APIRequestContext,
		page: Page,
		seeded: Seeded,
		path: string
	): Promise<void> {
		const renamed = await request.put('/api/attributes', {
			data: wireDefinitions([
				{
					id: seeded.departmentId,
					name: 'Team',
					kind: 'category',
					options: ['Packing', 'Delivery', 'No Department']
				},
				{ id: seeded.rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
			])
		});
		expect(renamed.ok(), await renamed.text()).toBeTruthy();
		await page.goto(path);
		await appReady(page);
	}
	test('@product-gap-03 Workers reads No Department for Casey and the literal answer for Drew', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await page.goto('/workers');
		await appReady(page);

		// The system reading: named from the Attribute, with the collision's secondary.
		const casey = page.getByRole('gridcell', {
			name: 'Department for Casey: No Department, No selection'
		});
		await expect(casey).toBeVisible();
		await expect(casey).toContainText('No Department');
		await expect(casey).toContainText('No selection');

		// The real answer keeps its text and gains no secondary description.
		const drew = page.getByRole('gridcell', { name: 'Department for Drew: No Department' });
		await expect(drew).toBeVisible();
		await expect(drew).toContainText('No Department');
		await expect(drew).not.toContainText('No selection');
		await expect(page.getByRole('gridcell', { name: /No selection/ })).toHaveCount(1);

		// Rename the Attribute, not any answer: the reading follows the configured name,
		// the real answer keeps its text, and the collision is gone.
		await renameDepartmentToTeam(request, page, seeded, '/workers');
		await expect(page.getByRole('gridcell', { name: 'Team for Casey: No Team' })).toBeVisible();
		await expect(
			page.getByRole('gridcell', { name: 'Team for Drew: No Department' })
		).toBeVisible();
		await expect(page.getByRole('gridcell', { name: /No selection/ })).toHaveCount(0);
	});
});

test.describe('E6 folds product-gap-06 attribute filters', () => {
	type Seeded = {
		departmentId: string;
		rolesId: string;
		workerIds: Record<string, string>;
	};

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const [departmentId, rolesId] = await addAttributes(request, [
			{
				name: 'Department',
				kind: 'category',
				options: ['Packing', 'Delivery', 'No Department']
			},
			{ name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
		]);
		const [english, spanish] = await addLanguages(request, ['English', 'Spanish']);
		const [equipment, schedule] = await addAgitations(request, ['Equipment', 'Schedule']);
		const created = await addWorkers(request, [
			{
				name: 'Alex',
				assessment: 'Leader',
				attributes: { [departmentId]: 'Packing', [rolesId]: ['Trainer'] },
				languages: [english],
				agitations: [equipment]
			},
			{
				name: 'Blair',
				assessment: 'Supporter',
				attributes: { [departmentId]: 'Delivery', [rolesId]: ['Trainer', 'Steward'] },
				languages: [spanish],
				agitations: [schedule],
				// A contact field and a Note that name Alex and Equipment; Name search must not read them.
				email: 'alex@example.test',
				notes: [
					{
						id: 'note-blair',
						text: 'Alex asked about Equipment',
						timestamp: '2024-01-01T00:00:00.000Z'
					}
				]
			},
			{
				name: 'Casey',
				assessment: 'Unassessed',
				attributes: { [departmentId]: '', [rolesId]: [] },
				languages: [english, spanish],
				agitations: [equipment]
			},
			{
				name: 'Drew',
				assessment: 'Activist',
				attributes: { [departmentId]: 'No Department', [rolesId]: ['Steward'] }
			}
		]);
		const names = ['Alex', 'Blair', 'Casey', 'Drew'];
		const workerIds = Object.fromEntries(names.map((name, index) => [name, created[index]]));

		return { departmentId, rolesId, workerIds };
	}

	async function renameDepartmentToTeam(request: APIRequestContext, seeded: Seeded): Promise<void> {
		const renamed = await request.put('/api/attributes', {
			data: wireDefinitions([
				{
					id: seeded.departmentId,
					name: 'Team',
					kind: 'category',
					options: ['Packing', 'Delivery', 'No Department']
				},
				{ id: seeded.rolesId, name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
			])
		});
		expect(renamed.ok(), await renamed.text()).toBeTruthy();
	}

	const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');
	const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
	const count = (page: Page) => page.getByTestId('worker-count');

	/** The system No Department choice, present even when a real answer reads the same. */
	const systemChoice = (page: Page) =>
		page
			.getByRole('menuitemcheckbox')
			.filter({ hasText: 'No Department' })
			.filter({ hasText: 'No selection' });

	/** The real answer literally named No Department. */
	const literalNoDepartment = (page: Page) =>
		page
			.getByRole('menuitemcheckbox')
			.filter({ hasText: 'No Department' })
			.filter({ hasNotText: 'No selection' });

	function chosenFilterParams(page: Page): { f: string[]; missing: string[] } {
		const params = new URL(page.url()).searchParams;
		return { f: params.getAll('f'), missing: params.getAll('missing') };
	}
	test('@product-gap-06 the no-selection choice matches Casey, the literal answer matches Drew', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(page);

		await openFilter(page, 'Department');
		await expect(systemChoice(page)).toBeVisible();
		await systemChoice(page).click();

		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		for (const name of ['Alex', 'Blair', 'Drew']) await expect(row(page, name)).toHaveCount(0);
		expect(chosenFilterParams(page)).toEqual({ f: [], missing: [seeded.departmentId] });

		const active = page.getByTestId('active-condition');
		await expect(active).toHaveCount(1);
		await expect(active).toContainText('No Department');
		await expect(active).toContainText('No selection');

		// The menu stays open for a second choice: swap the system reading for the real answer.
		await page.keyboard.press('Escape');
		await openFilter(page, 'Department');
		await systemChoice(page).click();
		await literalNoDepartment(page).click();

		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Drew')).toBeVisible();
		await expect(row(page, 'Casey')).toHaveCount(0);
		expect(chosenFilterParams(page)).toEqual({
			f: [`${seeded.departmentId}:${answerId(seeded.departmentId, 'No Department')}`],
			missing: []
		});
		await expect(active).toHaveCount(1);
		await expect(active).toContainText('No Department');
		await expect(active).not.toContainText('No selection');
	});
	test('@product-gap-06 No Department OR Delivery, then another facet narrows with AND', async ({
		page,
		request
	}) => {
		await seedFixture(request);
		await openWorkers(page);

		await openFilter(page, 'Department');
		await systemChoice(page).click();
		await page.getByRole('menuitemcheckbox', { name: 'Delivery, 1 worker', exact: true }).click();

		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Blair')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(row(page, 'Alex')).toHaveCount(0);
		await expect(row(page, 'Drew')).toHaveCount(0);

		// Another Attribute is a separate facet, so it ANDs with the Department union.
		await page.keyboard.press('Escape');
		await openFilter(page, 'Roles');
		await page.getByRole('menuitemcheckbox', { name: 'Trainer, 2 workers', exact: true }).click();

		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Blair')).toBeVisible();
		await expect(row(page, 'Casey')).toHaveCount(0);
		await expect(page.getByTestId('active-condition')).toHaveCount(3);

		// Removing the facet restores the union without touching Department.
		await page.getByRole('menuitemcheckbox', { name: 'Trainer, 2 workers', exact: true }).click();
		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Casey')).toBeVisible();
	});
	test('@product-gap-06 renaming Department to Team keeps membership and reads No Team', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(page, `/workers?missing=${seeded.departmentId}`);
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(page.getByTestId('active-condition')).toContainText('No Department');

		await renameDepartmentToTeam(request, seeded);
		await page.reload();
		await appReady(page);

		// The URL still names the Attribute id, so membership survives the rename; the reading follows it.
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		expect(chosenFilterParams(page).missing).toEqual([seeded.departmentId]);
		const active = page.getByTestId('active-condition');
		await expect(active).toContainText('No Team');
		await expect(active).not.toContainText('No Department');

		await openFilter(page, 'Team');
		await expect(page.getByRole('menuitemcheckbox').filter({ hasText: 'No Team' })).toBeChecked();
		// The real answer keeps its text: no secondary description is needed now.
		await expect(
			page.getByRole('menuitemcheckbox').filter({ hasText: 'No Department' })
		).toHaveCount(1);
	});
	test('@product-gap-06 reload, remove one condition, and Clear filters recover the expected sets', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		const delivery = encodeURIComponent(answerId(seeded.departmentId, 'Delivery'));
		await openWorkers(
			page,
			`/workers?missing=${seeded.departmentId}&f=${seeded.departmentId}:${delivery}`
		);
		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Blair')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();

		await page.reload();
		await appReady(page);
		await expect(count(page)).toHaveText('2 workers');
		await expect(page.getByTestId('active-condition')).toHaveCount(2);

		// Removing one condition leaves the other.
		await page
			.getByTestId('active-condition')
			.filter({ hasText: 'Delivery' })
			.getByRole('button', { name: 'Remove Delivery' })
			.click();
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		expect(chosenFilterParams(page).f).toEqual([]);
		expect(chosenFilterParams(page).missing).toEqual([seeded.departmentId]);

		await page
			.getByTestId('active-condition')
			.filter({ hasText: 'No Department' })
			.getByRole('button', { name: /Remove No Department/ })
			.click();
		await expect(count(page)).toHaveText('4 workers');
		expect(chosenFilterParams(page)).toEqual({ f: [], missing: [] });
		await expect(page.getByTestId('active-condition')).toHaveCount(0);

		// An interactive change replaces the current history entry, and its address reloads.
		const historyBefore = await page.evaluate(() => history.length);
		await openFilter(page, 'Department');
		await systemChoice(page).click();
		await expect(count(page)).toHaveText('1 worker');
		expect(await page.evaluate(() => history.length)).toBe(historyBefore);
		await page.keyboard.press('Escape');
		await page.reload();
		await appReady(page);
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();

		await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
		await expect(count(page)).toHaveText('4 workers');
		expect(chosenFilterParams(page)).toEqual({ f: [], missing: [] });
		await expect(page.getByTestId('active-condition')).toHaveCount(0);
	});
	test('@product-gap-06 malformed missing and f values recover safely', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);

		// A Multi-Select Attribute's empty list is the same no-selection reading.
		await openWorkers(page, `/workers?missing=${seeded.rolesId}`);
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(page.getByTestId('active-condition')).toHaveCount(1);
		await expect(page.getByTestId('active-condition')).toContainText('No Roles');

		// Unknown Attributes and unknown answer ids drop silently.
		await openWorkers(page, '/workers?missing=deleted-attribute&f=deleted-attribute:a1');
		await expect(count(page)).toHaveText('4 workers');
		await expect(page.getByTestId('active-condition')).toHaveCount(0);

		await openWorkers(
			page,
			`/workers?f=${seeded.departmentId}:deleted-answer&missing=${seeded.departmentId}`
		);
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();

		// Repeated missing values deduplicate to one condition.
		await openWorkers(
			page,
			`/workers?missing=&missing=${seeded.departmentId}&missing=${seeded.departmentId}`
		);
		await expect(count(page)).toHaveText('1 worker');
		await expect(page.getByTestId('active-condition')).toHaveCount(1);
	});
	test('@product-gap-06 the narrow Filters sheet offers the same choice and keeps the same state', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/workers');
		await appReady(page);

		await page.getByRole('button', { name: /^Filters/ }).click();
		const sheet = page.getByRole('dialog', { name: 'Filters' });
		const system = sheet.getByRole('checkbox').filter({ hasText: 'No Department' }).filter({
			hasText: 'No selection'
		});
		await expect(system).toBeVisible();
		await system.focus();
		// A native button with role checkbox is operable from the keyboard.
		await page.keyboard.press('Enter');
		await expect(system).toHaveAttribute('aria-checked', 'true');

		await page.keyboard.press('Escape');
		await expect(sheet).toHaveCount(0);
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		expect(chosenFilterParams(page)).toEqual({ f: [], missing: [seeded.departmentId] });
		await expect(page.getByTestId('active-condition')).toContainText('No selection');

		await page.getByRole('button', { name: /^Filters/ }).click();
		const reopened = page.getByRole('dialog', { name: 'Filters' });
		await reopened
			.getByRole('checkbox')
			.filter({ hasText: 'No Department' })
			.filter({ hasText: 'No selection' })
			.click();
		await reopened
			.getByRole('checkbox')
			.filter({ hasText: 'No Department' })
			.filter({ hasNotText: 'No selection' })
			.click();
		await page.keyboard.press('Escape');
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Drew')).toBeVisible();
		await expect(row(page, 'Casey')).toHaveCount(0);
	});
});

test.describe('E6 folds product-gap-08 agitation filters', () => {
	type Seeded = {
		departmentId: string;
		rolesId: string;
		agitations: Record<string, string>;
		workerIds: Record<string, string>;
	};

	async function seedFixture(request: APIRequestContext): Promise<Seeded> {
		const [departmentId, rolesId] = await addAttributes(request, [
			{
				name: 'Department',
				kind: 'category',
				options: ['Packing', 'Delivery', 'No Department']
			},
			{ name: 'Roles', kind: 'tag', options: ['Trainer', 'Steward'] }
		]);
		const [english, spanish] = await addLanguages(request, ['English', 'Spanish']);
		const [equipment, schedule] = await addAgitations(request, ['Equipment', 'Schedule']);
		const created = await addWorkers(request, [
			{
				name: 'Alex',
				assessment: 'Leader',
				attributes: { [departmentId]: 'Packing', [rolesId]: ['Trainer'] },
				languages: [english],
				agitations: [equipment]
			},
			{
				name: 'Blair',
				assessment: 'Supporter',
				attributes: { [departmentId]: 'Delivery', [rolesId]: ['Trainer', 'Steward'] },
				languages: [spanish],
				agitations: [schedule],
				// A contact field and a Note that name Alex and Equipment; Name search must not read them.
				email: 'alex@example.test',
				notes: [
					{
						id: 'note-blair',
						text: 'Alex asked about Equipment',
						timestamp: '2024-01-01T00:00:00.000Z'
					}
				]
			},
			{
				name: 'Casey',
				assessment: 'Unassessed',
				attributes: { [departmentId]: '', [rolesId]: [] },
				languages: [english, spanish],
				agitations: [equipment]
			},
			{
				name: 'Drew',
				assessment: 'Activist',
				attributes: { [departmentId]: 'No Department', [rolesId]: ['Steward'] }
			}
		]);
		const names = ['Alex', 'Blair', 'Casey', 'Drew'];
		const workerIds = Object.fromEntries(names.map((name, index) => [name, created[index]]));
		const agitations = { Equipment: equipment, Schedule: schedule };

		return { departmentId, rolesId, agitations, workerIds };
	}

	/** Renames one Agitation while keeping the other, as Configuration's Save does. */
	async function renameAgitation(
		request: APIRequestContext,
		seeded: Seeded,
		from: string,
		to: string
	): Promise<void> {
		const renamed = await request.put('/api/agitations', {
			data: [
				{ id: seeded.agitations[from], text: to },
				{ id: seeded.agitations.Schedule, text: 'Schedule' }
			]
		});
		expect(renamed.ok(), await renamed.text()).toBeTruthy();
	}

	/** Deletes one Agitation by saving the remaining set, as Configuration's Save does. */
	async function deleteAgitation(
		request: APIRequestContext,
		seeded: Seeded,
		text: string
	): Promise<void> {
		const remaining = Object.entries(seeded.agitations)
			.filter(([name]) => name !== text)
			.map(([, id]) => ({ id, text: nameOf(seeded, id) }));
		const deleted = await request.put('/api/agitations', { data: remaining });
		expect(deleted.ok(), await deleted.text()).toBeTruthy();
	}

	function nameOf(seeded: Seeded, id: string): string {
		for (const [name, agitationId] of Object.entries(seeded.agitations)) {
			if (agitationId === id) return name;
		}
		throw new Error(`No seeded Agitation with id ${id}`);
	}

	const rows = (page: Page) => page.locator('tbody tr[data-worker-id]');
	const row = (page: Page, name: string) => rows(page).filter({ hasText: name });
	const count = (page: Page) => page.getByTestId('worker-count');
	const conditions = (page: Page) => page.getByTestId('active-condition');

	function agitationParams(page: Page): string[] {
		return new URL(page.url()).searchParams.getAll('agitation');
	}

	/** The desktop toolbar Filters menu, opened. */
	async function openFiltersMenu(page: Page): Promise<void> {
		// Keyboard-open: an open Worker card can sit over the toolbar's right edge.
		await page.getByRole('button', { name: /^Filters/ }).focus();
		await page.keyboard.press('Enter');
	}

	/** The Agitations submenu of the desktop Filters menu. */
	async function openAgitations(page: Page): Promise<void> {
		await openFiltersMenu(page);
		await page.getByRole('menuitem', { name: /^Agitations/ }).click();
	}

	/** Closes every open menu layer, submenus first. */
	async function closeMenus(page: Page): Promise<void> {
		while ((await page.getByRole('menu').count()) > 0) {
			await page.keyboard.press('Escape');
		}
	}

	async function chooseAgitation(page: Page, text: string): Promise<void> {
		await page.getByRole('menuitemcheckbox', { name: text, exact: true }).click();
	}
	test('@product-gap-08 Equipment matches its holders, and Equipment OR Schedule adds Schedule holders', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(page);

		const historyBefore = await page.evaluate(() => history.length);
		await openAgitations(page);
		await chooseAgitation(page, 'Equipment');

		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(row(page, 'Blair')).toHaveCount(0);
		await expect(row(page, 'Drew')).toHaveCount(0);
		expect(agitationParams(page)).toEqual([seeded.agitations.Equipment]);
		await expect(conditions(page)).toHaveCount(1);
		await expect(conditions(page)).toContainText('Equipment');

		// A second Agitation ORs within the same facet: selecting it keeps the first.
		await chooseAgitation(page, 'Schedule');

		await expect(count(page)).toHaveText('3 workers');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(row(page, 'Blair')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(row(page, 'Drew')).toHaveCount(0);
		expect(agitationParams(page)).toEqual([
			seeded.agitations.Equipment,
			seeded.agitations.Schedule
		]);
		await expect(conditions(page)).toHaveCount(2);

		// Interactive changes replace the current history entry, never push a new one.
		expect(await page.evaluate(() => history.length)).toBe(historyBefore);
		await closeMenus(page);

		// Removing one condition restores the remaining condition's set.
		await conditions(page)
			.filter({ hasText: 'Equipment' })
			.getByRole('button', { name: 'Remove Equipment' })
			.click();
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Blair')).toBeVisible();
		expect(agitationParams(page)).toEqual([seeded.agitations.Schedule]);
	});
	test('@product-gap-08 Equipment AND No Department matches Casey; removing Equipment restores the rest', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(
			page,
			`/workers?missing=${seeded.departmentId}&agitation=${seeded.agitations.Equipment}`
		);

		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		await expect(conditions(page)).toHaveCount(2);
		await expect(conditions(page).filter({ hasText: 'Equipment' })).toHaveCount(1);

		// OR another Department answer: the Agitation facet still ANDs with the Attribute facet.
		await openFilter(page, 'Department');
		await page.getByRole('menuitemcheckbox', { name: 'Delivery, 1 worker', exact: true }).click();
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Casey')).toBeVisible();
		await closeMenus(page);

		// Dropping the Agitation leaves the Attribute facet: No Department OR Delivery.
		await conditions(page)
			.filter({ hasText: 'Equipment' })
			.getByRole('button', { name: 'Remove Equipment' })
			.click();
		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Blair')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();
		expect(agitationParams(page)).toEqual([]);
		expect(new URL(page.url()).searchParams.getAll('missing')).toEqual([seeded.departmentId]);
	});
	test('@product-gap-08 reload keeps the cohort and configured-name conditions, each removable', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(
			page,
			`/workers?agitation=${seeded.agitations.Equipment}&agitation=${seeded.agitations.Schedule}`
		);

		await expect(count(page)).toHaveText('3 workers');
		await expect(conditions(page)).toHaveCount(2);
		await expect(conditions(page).filter({ hasText: 'Equipment' })).toHaveCount(1);
		await expect(conditions(page).filter({ hasText: 'Schedule' })).toHaveCount(1);

		await page.reload();
		await appReady(page);
		await expect(count(page)).toHaveText('3 workers');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(row(page, 'Blair')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();
		expect(agitationParams(page)).toEqual([
			seeded.agitations.Equipment,
			seeded.agitations.Schedule
		]);

		const historyBefore = await page.evaluate(() => history.length);
		await conditions(page)
			.filter({ hasText: 'Equipment' })
			.getByRole('button', { name: 'Remove Equipment' })
			.click();
		await expect(count(page)).toHaveText('1 worker');
		await expect(row(page, 'Blair')).toBeVisible();
		expect(agitationParams(page)).toEqual([seeded.agitations.Schedule]);
		expect(await page.evaluate(() => history.length)).toBe(historyBefore);

		await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
		await expect(count(page)).toHaveText('4 workers');
		expect(agitationParams(page)).toEqual([]);
		await expect(conditions(page)).toHaveCount(0);
	});
	test('@product-gap-08 renaming an Agitation keeps membership and updates its text', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(page, `/workers?agitation=${seeded.agitations.Equipment}`);
		await expect(count(page)).toHaveText('2 workers');
		await expect(conditions(page)).toContainText('Equipment');

		await renameAgitation(request, seeded, 'Equipment', 'Gear');
		await page.reload();
		await appReady(page);

		// The address names the stable id, so the cohort survives the rename.
		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();
		expect(agitationParams(page)).toEqual([seeded.agitations.Equipment]);
		await expect(conditions(page)).toHaveCount(1);
		await expect(conditions(page)).toContainText('Gear');
		await expect(conditions(page)).not.toContainText('Equipment');

		// The filter group lists the configured text too.
		await openAgitations(page);
		await expect(page.getByRole('menuitemcheckbox', { name: 'Gear', exact: true })).toBeVisible();
		await expect(
			page.getByRole('menuitemcheckbox', { name: 'Equipment', exact: true })
		).toHaveCount(0);
	});
	test('@product-gap-08 deleting an Agitation drops its stale condition on reload', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await openWorkers(page, `/workers?agitation=${seeded.agitations.Equipment}`);
		await expect(count(page)).toHaveText('2 workers');

		await deleteAgitation(request, seeded, 'Equipment');
		await page.reload();
		await appReady(page);

		// The unknown id is ignored: every Worker is shown, with no stale condition.
		await expect(count(page)).toHaveText('4 workers');
		await expect(conditions(page)).toHaveCount(0);
		await expect(row(page, 'Drew')).toBeVisible();

		// And the deleted Agitation is gone from the facet's choices.
		await openAgitations(page);
		await expect(
			page.getByRole('menuitemcheckbox', { name: 'Schedule', exact: true })
		).toBeVisible();
		await expect(
			page.getByRole('menuitemcheckbox', { name: 'Equipment', exact: true })
		).toHaveCount(0);
	});
	test('@product-gap-08 the narrow Filters sheet offers the same Agitation facet and state', async ({
		page,
		request
	}) => {
		const seeded = await seedFixture(request);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/workers');
		await appReady(page);

		// Keyboard-open: an open Worker card can sit over the toolbar's right edge.
		await page.getByRole('button', { name: /^Filters/ }).focus();
		await page.keyboard.press('Enter');
		const sheet = page.getByRole('dialog', { name: 'Filters' });
		const equipment = sheet.getByRole('checkbox').filter({ hasText: 'Equipment' });
		await expect(equipment).toBeVisible();
		await equipment.focus();
		// A native button with role checkbox is operable from the keyboard.
		await page.keyboard.press('Enter');
		await expect(equipment).toHaveAttribute('aria-checked', 'true');

		await page.keyboard.press('Escape');
		await expect(sheet).toHaveCount(0);
		await expect(count(page)).toHaveText('2 workers');
		await expect(row(page, 'Alex')).toBeVisible();
		await expect(row(page, 'Casey')).toBeVisible();
		expect(agitationParams(page)).toEqual([seeded.agitations.Equipment]);
		await expect(conditions(page)).toContainText('Equipment');

		// The same configured-text condition is individually removable at this width.
		await conditions(page)
			.filter({ hasText: 'Equipment' })
			.getByRole('button', { name: 'Remove Equipment' })
			.click();
		await expect(count(page)).toHaveText('4 workers');
		expect(agitationParams(page)).toEqual([]);
	});
});
