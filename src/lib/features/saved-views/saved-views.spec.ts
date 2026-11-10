import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/client/api-error.ts';
import type { SavedView, SavedViewSnapshot } from '#lib/domain-vocabulary.ts';
import {
	createSavedViews,
	snapshotKey,
	type SavedViewsApi,
	type SavedViewsHost
} from './saved-views.svelte.ts';
import {
	savedView,
	stewardId,
	vocabulary,
	workersSnapshot,
	workersView
} from './saved-view-fixtures.ts';

function setup(initial: SavedView[] = [], live: SavedViewSnapshot = workersSnapshot()) {
	let stored = [...initial];
	let screen = live;
	let nextId = 1;
	const applied: SavedViewSnapshot[] = [];
	const api: SavedViewsApi = {
		list: vi.fn(async () => stored),
		create: vi.fn(async (name, snapshot) => {
			if (stored.some((view) => view.name.toLowerCase() === name.toLowerCase())) {
				throw new ApiError(409, 'taken', 'view_name_taken');
			}
			const view = savedView(`new-${nextId++}`, name, snapshot);
			stored = [...stored, view];
			return view;
		}),
		update: vi.fn(async (id, change) => {
			const current = stored.find((view) => view.id === id)!;
			const view = {
				...current,
				name: change.name ?? current.name,
				snapshot: change.snapshot ?? current.snapshot
			};
			stored = stored.map((entry) => (entry.id === id ? view : entry));
			return view;
		}),
		remove: vi.fn(async (id) => {
			stored = stored.filter((view) => view.id !== id);
		})
	};
	const host: SavedViewsHost = {
		kind: 'workers',
		api,
		vocabulary: () => vocabulary,
		capture: () => screen,
		apply: (snapshot) => {
			applied.push(snapshot);
			screen = snapshot;
		}
	};
	return {
		views: createSavedViews(host),
		api,
		applied,
		setScreen: (next: SavedViewSnapshot) => (screen = next)
	};
}

const brokenView = savedView(
	'broken',
	'Broken',
	workersSnapshot(
		workersView({
			filters: {
				population: { answers: { role: [stewardId, 'role~Gone'] }, exactAnswers: {}, missing: [] },
				agitations: [],
				languages: ['lang-gone'],
				assessments: []
			}
		})
	)
);

describe('opening a view', () => {
	it('applies a view whose references read, as an editable copy that writes nothing', async () => {
		const good = savedView('a', 'Day shift', workersSnapshot());
		const { views, api, applied } = setup([good]);
		await views.load();
		views.open(views.views[0]!);
		expect(applied).toEqual([good.snapshot]);
		expect(views.opened?.id).toBe('a');
		expect(views.review).toBeNull();
		expect(api.update).not.toHaveBeenCalled();
		expect(api.create).not.toHaveBeenCalled();
	});

	it('lists only the host’s kind', async () => {
		const mapping = savedView('m', 'Map', {
			version: 1,
			kind: 'mapping',
			mapping: undefined
		});
		const { views } = setup([savedView('a', 'A', workersSnapshot()), mapping]);
		await views.load();
		expect(views.views.map((view) => view.id)).toEqual(['a']);
	});
});

describe('Needs review', () => {
	it('holds a view with broken references, applying nothing, until each is dropped', async () => {
		const { views, applied } = setup([brokenView]);
		await views.load();
		views.open(views.views[0]!);
		expect(applied).toEqual([]);
		expect(views.opened).toBeUndefined();
		expect(views.review?.problems.map((problem) => problem.kind)).toEqual(['answer', 'language']);

		views.confirmReview();
		expect(applied).toEqual([]);

		views.drop(views.review!.problems[0]!.key);
		expect(views.review?.problems).toHaveLength(1);
		views.confirmReview();
		expect(applied).toEqual([]);

		views.drop(views.review!.problems[0]!.key);
		expect(views.review?.problems).toEqual([]);
		views.confirmReview();
		expect(views.review).toBeNull();
		expect(views.opened?.id).toBe('broken');
		// Only the broken references were dropped; the answer that still reads is kept.
		expect(applied[0]?.workers?.filters.population.answers).toEqual({ role: [stewardId] });
		expect(applied[0]?.workers?.filters.languages).toEqual([]);
	});

	it('cancel leaves the question and the stored view as they were', async () => {
		const { views, applied, api } = setup([brokenView]);
		await views.load();
		views.open(views.views[0]!);
		views.cancelReview();
		expect(views.review).toBeNull();
		expect(applied).toEqual([]);
		expect(api.update).not.toHaveBeenCalled();
		expect(views.views[0]?.snapshot).toEqual(brokenView.snapshot);
	});
});

describe('Save as, Update, Rename and Delete', () => {
	it('Save as stores what is on screen and opens it', async () => {
		const { views, api } = setup();
		expect(await views.saveAs('Quiet shift')).toBe(true);
		expect(api.create).toHaveBeenCalledWith('Quiet shift', workersSnapshot());
		expect(views.opened?.name).toBe('Quiet shift');
		expect(views.views).toHaveLength(1);
	});

	it('words a taken name and keeps the list', async () => {
		const { views } = setup([savedView('a', 'Day shift', workersSnapshot())]);
		await views.load();
		expect(await views.saveAs('day SHIFT')).toBe(false);
		expect(views.failure).toBe('nameTaken');
		expect(views.views).toHaveLength(1);
	});

	it('Update is explicit: it overwrites only when called, and reports a changed screen', async () => {
		const { views, api, setScreen } = setup([savedView('a', 'Day shift', workersSnapshot())]);
		await views.load();
		views.open(views.views[0]!);
		expect(views.openedChanged).toBe(false);

		const changed = workersSnapshot(workersView({ hiddenColumns: ['assessment'] }));
		setScreen(changed);
		expect(views.openedChanged).toBe(true);
		expect(api.update).not.toHaveBeenCalled();

		await views.update();
		expect(api.update).toHaveBeenCalledWith('a', { snapshot: changed });
		expect(views.opened?.snapshot).toEqual(changed);
		expect(views.openedChanged).toBe(false);
	});

	it('Rename keeps the id; Delete drops the open view', async () => {
		const { views } = setup([savedView('a', 'Day shift', workersSnapshot())]);
		await views.load();
		views.open(views.views[0]!);
		await views.rename('a', 'Night shift');
		expect(views.opened?.id).toBe('a');
		expect(views.opened?.name).toBe('Night shift');
		await views.remove('a');
		expect(views.views).toEqual([]);
		expect(views.opened).toBeUndefined();
	});

	it('names a failed load', async () => {
		const { views, api } = setup();
		vi.mocked(api.list).mockRejectedValueOnce(new Error('offline'));
		expect(await views.load()).toBe(false);
		expect(views.failure).toBe('load');
	});
});

describe('snapshotKey', () => {
	it('ignores the order of ids and keys but not the order of sort or columns', () => {
		const a = workersSnapshot(
			workersView({ hiddenColumns: ['x', 'y'], order: ['a', 'b'], sort: [] })
		);
		const b = workersSnapshot(
			workersView({ hiddenColumns: ['y', 'x'], order: ['a', 'b'], sort: [] })
		);
		const c = workersSnapshot(
			workersView({ hiddenColumns: ['x', 'y'], order: ['b', 'a'], sort: [] })
		);
		expect(snapshotKey(a)).toBe(snapshotKey(b));
		expect(snapshotKey(a)).not.toBe(snapshotKey(c));
	});
});
