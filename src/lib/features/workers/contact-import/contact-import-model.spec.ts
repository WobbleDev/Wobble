import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/client/api-error.ts';
import { createContactImport, type ContactImportHost } from './contact-import-model.svelte.ts';

function file(text: string) {
	return { name: 'workers.csv', text: async () => text };
}

const attribute = { id: 'a1', name: 'A1', kind: 'tag' as const, answers: [] };

function host(overrides: Partial<ContactImportHost> = {}): ContactImportHost {
	return {
		snapshot: vi.fn().mockResolvedValue({
			worksiteId: 'ws1',
			worksiteName: 'Worksite 01',
			attributes: [attribute],
			workers: []
		}),
		importRows: vi.fn().mockImplementation(async (rows: { row: number }[]) => ({
			imported: rows.length,
			created: rows.map((r) => ({ row: r.row, id: `w${r.row}` }))
		})),
		refresh: vi.fn().mockResolvedValue(undefined),
		openCreated: vi.fn().mockResolvedValue(undefined),
		...overrides
	};
}

const csv = 'Name,Phone\nWorker 01,5550100100\n,abc\nWorker 03,555-0101\n';

describe('the contact import', () => {
	it('reviews against the Worksite and vocabulary read with the file', async () => {
		const model = createContactImport(host());
		await model.chooseFile(file(csv));
		expect(model.stage).toBe('review');
		expect(model.worksiteName).toBe('Worksite 01');
		expect(model.skippedCount).toBe(1);
		expect(model.blankPhoneCount).toBe(1);
		expect(model.acceptedCount).toBe(2);
		expect(model.samples('name')).toEqual(['Worker 01', 'Worker 03']);
	});

	it('commits only accepted rows, with source rows and the reviewed vocabulary', async () => {
		const h = host();
		const model = createContactImport(h);
		await model.chooseFile(file(csv));
		expect(await model.commit()).toBe(true);

		expect(h.importRows).toHaveBeenCalledWith(
			[
				{ row: 2, name: 'Worker 01', email: '', phone: '(555) 010-0100' },
				{ row: 4, name: 'Worker 03', email: '', phone: '' }
			],
			['a1']
		);
		expect(model.stage).toBe('complete');
		expect(model.committedBlankPhones).toBe(1);
		expect(model.committedSkipped).toBe(1);
		expect(h.refresh).toHaveBeenCalled();
	});

	it('opens the created Workers in the reply order', async () => {
		const h = host();
		const model = createContactImport(h);
		await model.chooseFile(file(csv));
		await model.commit();
		await model.continueToWorkers();
		expect(h.openCreated).toHaveBeenCalledWith('ws1', ['w2', 'w4']);
	});

	it('blocks the commit when the vocabulary changed after the review, then reads it again', async () => {
		const importRows = vi
			.fn()
			.mockRejectedValueOnce(
				new ApiError(409, 'Changed.', 'import_stale_vocabulary', {
					code: 'import_stale_vocabulary'
				})
			)
			.mockImplementation(async (rows: { row: number }[]) => ({
				imported: rows.length,
				created: rows.map((r) => ({ row: r.row, id: `w${r.row}` }))
			}));
		const snapshot = vi
			.fn()
			.mockResolvedValueOnce({
				worksiteId: 'ws1',
				worksiteName: 'Worksite 01',
				attributes: [attribute],
				workers: []
			})
			.mockResolvedValueOnce({
				worksiteId: 'ws1',
				worksiteName: 'Worksite 01',
				attributes: [attribute, { ...attribute, id: 'a2', name: 'A2' }],
				workers: []
			});
		const model = createContactImport(host({ importRows, snapshot }));
		await model.chooseFile(file(csv));

		expect(await model.commit()).toBe(false);
		expect(model.error).toEqual({ code: 'stale_vocabulary' });
		expect(model.stage).toBe('review');
		expect(model.result).toBeNull();

		expect(await model.commit()).toBe(true);
		expect(importRows).toHaveBeenLastCalledWith(expect.anything(), ['a1', 'a2']);
	});

	it('keeps the review and creates nothing when the commit fails', async () => {
		const h = host({ importRows: vi.fn().mockRejectedValue(new Error('down')) });
		const model = createContactImport(h);
		await model.chooseFile(file(csv));
		expect(await model.commit()).toBe(false);
		expect(model.error).toEqual({ code: 'import_failed' });
		expect(model.stage).toBe('review');
	});

	it('reports a refresh failure without losing the result', async () => {
		const model = createContactImport(host({ refresh: vi.fn().mockRejectedValue(new Error('x')) }));
		await model.chooseFile(file(csv));
		await model.commit();
		expect(model.stage).toBe('complete');
		expect(model.refreshFailed).toBe(true);
		expect(model.result?.created).toHaveLength(2);
	});

	it('pages the problems view and resets to the first page on a filter change', async () => {
		const lines = Array.from({ length: 60 }, (_, i) => (i % 10 === 9 ? ',x' : `Worker ${i},`));
		const model = createContactImport(host());
		await model.chooseFile(file(`Name,Phone\n${lines.join('\n')}\n`));
		model.setPage(3);
		expect(model.view.page).toBe(3);
		model.setFilter('problems');
		expect(model.view.page).toBe(1);
		expect(model.view.total).toBe(6);
		model.setPage(9);
		expect(model.view.page).toBe(1);
	});

	it('stays on upload and says so for a file with no rows', async () => {
		const model = createContactImport(host());
		await model.chooseFile(file('Name,Phone\n'));
		expect(model.error).toEqual({ code: 'empty' });
		expect(model.stage).toBe('upload');
	});

	describe('Attributes and duplicates', () => {
		const department = {
			id: 'department',
			name: 'Department',
			kind: 'category' as const,
			answers: [
				{ id: 'kitchen', value: 'Kitchen' },
				{ id: 'cook', value: 'Cook', parentId: 'kitchen' },
				{ id: 'floor', value: 'Floor' }
			]
		};
		const skills = {
			id: 'skills',
			name: 'Skills',
			kind: 'tag' as const,
			answers: [
				{ id: 'spanish', value: 'Spanish' },
				{ id: 'forklift', value: 'Forklift' }
			]
		};
		const existing = [
			{ id: 'e1', name: 'Ada Lovelace', email: 'ada@example.test', phone: '(555) 010-0100' }
		];
		const withVocabulary = (overrides: Partial<ContactImportHost> = {}) =>
			host({
				snapshot: vi.fn().mockResolvedValue({
					worksiteId: 'ws1',
					worksiteName: 'Worksite 01',
					attributes: [department, skills],
					workers: existing
				}),
				...overrides
			});
		const attributeCsv =
			'Name,Department,Skills\n' +
			'Worker 01,Kitchen > Cook,Spanish; Forklift\n' +
			'Worker 02,Welding,Spanish\n' +
			'Worker 03,,Forklift\n';

		it('maps a column to an Attribute by its name and imports the chosen answers', async () => {
			const h = withVocabulary();
			const model = createContactImport(h);
			await model.chooseFile(file(attributeCsv));
			expect(model.attributeColumns).toEqual({ department: 1, skills: 2 });
			expect(model.undecidedCount).toBe(1);
			expect(await model.commit()).toBe(false);

			model.decideAttribute(3, 'omit');
			expect(await model.commit()).toBe(true);
			expect(h.importRows).toHaveBeenCalledWith(
				[
					{
						row: 2,
						name: 'Worker 01',
						email: '',
						phone: '',
						attributes: { department: 'cook', skills: ['spanish', 'forklift'] }
					},
					{ row: 3, name: 'Worker 02', email: '', phone: '', attributes: { skills: ['spanish'] } },
					{ row: 4, name: 'Worker 03', email: '', phone: '', attributes: { skills: ['forklift'] } }
				],
				['department', 'skills']
			);
		});

		it('skips a row the organizer skips, and creates no vocabulary for the unknown', async () => {
			const h = withVocabulary();
			const model = createContactImport(h);
			await model.chooseFile(file(attributeCsv));
			model.decideAttribute(3, 'skip');
			await model.commit();
			const sent = vi.mocked(h.importRows).mock.calls[0]?.[0] ?? [];
			expect(sent.map((row) => row.row)).toEqual([2, 4]);
			expect(model.committedSkipped).toBe(1);
		});

		it('keeps a row pending until it is decided, and decides all rows at once on request', async () => {
			const model = createContactImport(withVocabulary());
			await model.chooseFile(file(attributeCsv));
			expect(model.rows.map((row) => row.disposition)).toEqual(['import', 'undecided', 'import']);
			model.decideAllAttributes('omit');
			expect(model.undecidedCount).toBe(0);
		});

		it('asks again for every row after a different column is chosen', async () => {
			const model = createContactImport(withVocabulary());
			await model.chooseFile(file(attributeCsv));
			model.decideAttribute(3, 'omit');
			model.setAttributeColumn('skills', -1);
			expect(model.undecidedCount).toBe(1);
		});

		it('suggests existing Workers with their reasons and waits for Skip or create separate', async () => {
			const h = withVocabulary();
			const model = createContactImport(h);
			await model.chooseFile(file('Name,Phone,Email\nAda Lovelace,5550100100,\nWorker 02,,\n'));
			const [first, second] = model.rows;
			expect(first?.duplicates).toEqual([
				{ workerId: 'e1', workerName: 'Ada Lovelace', reasons: ['phone', 'name'] }
			]);
			expect(second?.duplicates).toEqual([]);
			expect(first?.disposition).toBe('undecided');
			expect(await model.commit()).toBe(false);

			model.decideDuplicate(2, 'skip');
			expect(model.rows[0]?.disposition).toBe('skip');
			model.decideDuplicate(2, 'create');
			expect(model.rows[0]?.disposition).toBe('import');
		});

		it('never merges: creating separately offers the pair to compare by hand', async () => {
			const h = withVocabulary();
			const model = createContactImport(h);
			await model.chooseFile(file('Name,Phone\nAda Lovelace,5550100100\nWorker 02,\n'));
			model.decideDuplicate(2, 'create');
			await model.commit();
			expect(model.committedDuplicateCount).toBe(1);
			await model.continueToDuplicates();
			expect(h.openCreated).toHaveBeenCalledWith('ws1', ['w2', 'e1']);
		});

		it('blocks the commit when an answer was removed between review and commit, then asks again', async () => {
			const importRows = vi.fn().mockRejectedValueOnce(
				new ApiError(409, 'Changed.', 'import_stale_vocabulary', {
					code: 'import_stale_vocabulary'
				})
			);
			const snapshot = vi
				.fn()
				.mockResolvedValueOnce({
					worksiteId: 'ws1',
					worksiteName: 'Worksite 01',
					attributes: [department, skills],
					workers: []
				})
				.mockResolvedValueOnce({
					worksiteId: 'ws1',
					worksiteName: 'Worksite 01',
					attributes: [department, { ...skills, answers: [skills.answers[1]!] }],
					workers: []
				});
			const model = createContactImport(host({ importRows, snapshot }));
			await model.chooseFile(file(attributeCsv));
			model.decideAttribute(3, 'omit');

			expect(await model.commit()).toBe(false);
			expect(model.error).toEqual({ code: 'stale_vocabulary' });
			expect(model.result).toBeNull();
			// "Spanish" no longer exists: its rows are put to the organizer again.
			expect(model.undecidedCount).toBe(2);
		});
	});
});
