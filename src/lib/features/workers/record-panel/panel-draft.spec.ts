import { describe, expect, it } from 'vitest';
import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import {
	buildPanelDraft,
	draftBaseChanged,
	draftDifferences,
	hasUnsavedInput,
	noEditors,
	readPanelDraft,
	type OpenEditors
} from './panel-draft.ts';

const attributes: WorkerAttributeDefinition[] = [
	{
		id: 'a-department',
		name: 'Department',
		kind: 'category',
		answers: [
			{ id: 'd-front', value: 'Front of House' },
			{ id: 'd-back', value: 'Back of House' }
		]
	},
	{
		id: 'a-shifts',
		name: 'Shifts',
		kind: 'tag',
		answers: [
			{ id: 's-day', value: 'Day' },
			{ id: 's-night', value: 'Night' }
		]
	}
];

/** A Worker with one Note: everything the draft reads. */
const worker = (extra: Partial<Worker> = {}) =>
	baseWorker({
		name: 'Ada Lovelace',
		email: 'ada@example.test',
		assessment: 'Supporter',
		notes: [{ id: 'n1', text: 'Old', timestamp: '2024-01-01T09:00:00.000Z' }],
		...extra
	});

describe('buildPanelDraft and readPanelDraft', () => {
	it('round-trips every kind of open editor, including both Attribute kinds', () => {
		const ada = worker({ attributes: { 'a-department': 'd-front', 'a-shifts': ['s-day'] } });
		const open: OpenEditors = {
			name: 'New name',
			email: 'a@b.test',
			phone: '123',
			composer: { text: 'Half' },
			noteEdits: { n1: { text: 'Edited' } },
			attributes: { 'a-department': 'd-back', 'a-shifts': ['s-day', 's-night'] }
		};

		const stored = {
			...buildPanelDraft(ada, attributes, open),
			updatedAt: '2024-01-01T00:00:00Z'
		};

		expect(readPanelDraft(stored)).toEqual(open);
	});

	it('carries every configured Attribute in both update and base, held or not', () => {
		const ada = worker({ attributes: { 'a-department': 'd-front' } });
		const draft = buildPanelDraft(ada, attributes, noEditors());

		for (const value of [draft.update, draft.base]) {
			expect(value?.attributes).toEqual({ 'a-department': 'd-front', 'a-shifts': [] });
		}
	});

	it('reopens only an Attribute the stored update changed from its base', () => {
		const ada = worker({ attributes: { 'a-department': 'd-front', 'a-shifts': ['s-day'] } });
		const draft = buildPanelDraft(ada, attributes, noEditors());
		const changed = {
			...draft,
			update: {
				...draft.update,
				attributes: { ...draft.update.attributes, 'a-shifts': ['s-night'] }
			},
			updatedAt: '2024-01-01T00:00:00Z'
		};

		expect(readPanelDraft(changed)).toEqual({
			noteEdits: {},
			attributes: { 'a-shifts': ['s-night'] }
		});
	});

	it('a draft with no base reopens nothing', () => {
		const built = buildPanelDraft(
			worker({ attributes: { 'a-department': 'd-front' } }),
			attributes,
			{
				name: 'New name',
				composer: { text: 'Half' },
				noteEdits: {},
				attributes: { 'a-department': 'd-back' }
			}
		);

		expect(
			readPanelDraft({
				update: built.update,
				pendingNote: { text: 'x' },
				base: null,
				updatedAt: '2024-01-01T00:00:00Z'
			})
		).toEqual(noEditors());
	});
});

describe('hasUnsavedInput', () => {
	it("an editor holding the record's own value is not unsaved input", () => {
		const ada = worker();

		expect(
			hasUnsavedInput(ada, {
				name: ada.name,
				noteEdits: { n1: { text: 'Old' } },
				attributes: {}
			})
		).toBe(false);
	});

	it('a typed Email is unsaved input', () => {
		expect(hasUnsavedInput(worker(), { email: 'x@y.test', noteEdits: {}, attributes: {} })).toBe(
			true
		);
	});

	it('a changed Attribute is unsaved input, and an equal set in another order is not', () => {
		const ada = worker({
			attributes: { 'a-department': 'd-front', 'a-shifts': ['s-day', 's-night'] }
		});

		expect(
			hasUnsavedInput(ada, {
				noteEdits: {},
				attributes: { 'a-shifts': ['s-night', 's-day'] }
			})
		).toBe(false);
		expect(
			hasUnsavedInput(ada, {
				noteEdits: {},
				attributes: { 'a-shifts': ['s-night'] }
			})
		).toBe(true);
		expect(
			hasUnsavedInput(ada, {
				noteEdits: {},
				attributes: { 'a-department': 'd-back' }
			})
		).toBe(true);
	});
});

describe('draftBaseChanged', () => {
	it('the base has not changed for the same record', () => {
		const ada = worker();
		const stored = {
			...buildPanelDraft(ada, [], noEditors()),
			updatedAt: '2024-01-01T00:00:00Z'
		};

		expect(draftBaseChanged(stored, ada, [])).toBe(false);
	});

	it('the base has changed after a field changes', () => {
		const ada = worker();
		const stored = {
			...buildPanelDraft(ada, [], noEditors()),
			updatedAt: '2024-01-01T00:00:00Z'
		};

		expect(draftBaseChanged(stored, { ...ada, email: 'changed@x.test' }, [])).toBe(true);
	});
});

describe('draftDifferences', () => {
	it('lists only the text fields where the draft differs from the saved record', () => {
		const ada = worker();
		const stored = {
			...buildPanelDraft(ada, [], { ...noEditors(), email: 'draft@x.test' }),
			updatedAt: '2024-01-01T00:00:00Z'
		};

		expect(draftDifferences(stored, ada)).toEqual([
			{ field: 'email', saved: 'ada@example.test', draft: 'draft@x.test' }
		]);
		expect(draftDifferences(stored, { ...ada, email: 'draft@x.test' })).toEqual([]);
	});
});

describe('a depth-five Attribute answer in the record panel', () => {
	const chain: WorkerAttributeDefinition = {
		id: 'a-chain',
		name: 'Chain',
		kind: 'tag',
		answers: [
			{ id: 'l1', value: 'Level 1' },
			{ id: 'l2', value: 'Level 2', parentId: 'l1' },
			{ id: 'l3', value: 'Level 3', parentId: 'l2' },
			{ id: 'l4', value: 'Level 4', parentId: 'l3' },
			{ id: 'l5', value: 'Level 5', parentId: 'l4' }
		]
	};

	it('treats a held depth-five answer as saved and a changed one as unsaved input', () => {
		const ada = worker({ attributes: { 'a-chain': ['l5'] } });

		expect(hasUnsavedInput(ada, { noteEdits: {}, attributes: { 'a-chain': ['l5'] } })).toBe(false);
		expect(hasUnsavedInput(ada, { noteEdits: {}, attributes: { 'a-chain': ['l4'] } })).toBe(true);
	});

	it('round-trips an edited depth-five choice through the stored draft', () => {
		const ada = worker({ attributes: { 'a-chain': ['l5'] } });
		const open: OpenEditors = { noteEdits: {}, attributes: { 'a-chain': ['l4'] } };
		const built = buildPanelDraft(ada, [chain], open);

		expect(built.update.attributes).toEqual({ 'a-chain': ['l4'] });
		expect(built.base?.attributes).toEqual({ 'a-chain': ['l5'] });
		expect(readPanelDraft({ ...built, updatedAt: '2024-01-01T00:00:00Z' })).toEqual(open);
	});
});
