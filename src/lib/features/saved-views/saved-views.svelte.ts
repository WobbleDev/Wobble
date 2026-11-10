/**
 * The saved views of one view host (Workers or Mapping): the list, the view currently
 * open, and the Needs review step. A view opens as an editable copy: applying it sets the
 * live question and writes nothing back; only the explicit Update, Save as, Rename and
 * Delete change what is stored. A view whose references no longer read opens as Needs
 * review, where each broken reference is dropped or the whole open is cancelled.
 */
import { ApiError } from '#lib/client/api-error.ts';
import type { SavedView, SavedViewKind, SavedViewSnapshot } from '#lib/domain-vocabulary.ts';
import {
	findViewProblems,
	type ViewProblem,
	type ViewVocabulary
} from './saved-view-references.ts';

/** The stored-views calls the controller makes: the client in the app, a literal in specs. */
export type SavedViewsApi = {
	list: () => Promise<SavedView[]>;
	create: (name: string, snapshot: SavedViewSnapshot) => Promise<SavedView>;
	update: (
		id: string,
		change: { name?: string; snapshot?: SavedViewSnapshot }
	) => Promise<SavedView>;
	remove: (id: string) => Promise<void>;
};

/** What the host supplies: which kind it shows, and how to read and set its question. */
export type SavedViewsHost = {
	kind: SavedViewKind;
	api: SavedViewsApi;
	vocabulary: () => ViewVocabulary;
	/** The host's question as it stands, without any person state. */
	capture: () => SavedViewSnapshot;
	/** Sets the host's question from a snapshot whose references all read. */
	apply: (snapshot: SavedViewSnapshot) => void;
};

/** Why the last action failed; the control words each one. */
export type SavedViewsFailure = 'load' | 'save' | 'nameTaken' | 'invalidName' | 'gone';

/** A view held back until each broken reference is dropped. */
export type ViewReview = {
	view: SavedView;
	/** The snapshot with every dropped reference removed. */
	pending: SavedViewSnapshot;
	/** The references still to decide. */
	problems: ViewProblem[];
};

/** A key that is equal for two snapshots that say the same thing in a different order. */
export function snapshotKey(snapshot: SavedViewSnapshot): string {
	const unordered = (key: string) => key !== 'sort' && key !== 'order';
	const walk = (value: unknown, key: string): unknown => {
		if (Array.isArray(value)) {
			const items = value.map((entry) => walk(entry, key));
			return unordered(key) && items.every((item) => typeof item === 'string')
				? [...items].sort()
				: items;
		}
		if (typeof value === 'object' && value !== null) {
			return Object.fromEntries(
				Object.entries(value)
					.sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
					.map(([entryKey, entry]) => [entryKey, walk(entry, entryKey)])
			);
		}
		return value;
	};
	return JSON.stringify(walk(snapshot, ''));
}

function failureOf(error: unknown, fallback: SavedViewsFailure): SavedViewsFailure {
	if (error instanceof ApiError) {
		if (error.code === 'view_name_taken') return 'nameTaken';
		if (error.code === 'invalid_view_name') return 'invalidName';
		if (error.code === 'view_not_found') return 'gone';
	}
	return fallback;
}

function byName(first: SavedView, second: SavedView): number {
	return first.name.localeCompare(second.name);
}

export function createSavedViews(host: SavedViewsHost) {
	let views = $state<SavedView[]>([]);
	let loaded = $state(false);
	let busy = $state(false);
	let failure = $state<SavedViewsFailure | null>(null);
	let openedId = $state<string | null>(null);
	let review = $state<ViewReview | null>(null);

	const opened = $derived(views.find((view) => view.id === openedId));

	function replace(view: SavedView) {
		views = [...views.filter((entry) => entry.id !== view.id), view].sort(byName);
	}

	async function run(fallback: SavedViewsFailure, action: () => Promise<void>): Promise<boolean> {
		busy = true;
		failure = null;
		try {
			await action();
			return true;
		} catch (error) {
			failure = failureOf(error, fallback);
			return false;
		} finally {
			busy = false;
		}
	}

	return {
		get views() {
			return views;
		},
		get loaded() {
			return loaded;
		},
		get busy() {
			return busy;
		},
		get failure() {
			return failure;
		},
		get opened() {
			return opened;
		},
		get review() {
			return review;
		},
		/** Whether the question on screen differs from the open view, so Update would change it. */
		get openedChanged(): boolean {
			return opened !== undefined && snapshotKey(host.capture()) !== snapshotKey(opened.snapshot);
		},

		/** Reads the Worksite's views of this host's kind. */
		load: () =>
			run('load', async () => {
				const all = await host.api.list();
				views = all.filter((view) => view.kind === host.kind).sort(byName);
				loaded = true;
				if (openedId !== null && !views.some((view) => view.id === openedId)) openedId = null;
			}),

		/** Opens a view as an editable copy, or holds it for review when a reference is broken. */
		open(view: SavedView) {
			failure = null;
			const problems = findViewProblems(view.snapshot, host.vocabulary());
			if (problems.length > 0) {
				review = { view, pending: view.snapshot, problems };
				return;
			}
			host.apply(view.snapshot);
			openedId = view.id;
		},

		/** Drops one broken reference from the view being reviewed; the stored view is unchanged. */
		drop(key: string) {
			if (!review) return;
			const problem = review.problems.find((entry) => entry.key === key);
			if (!problem) return;
			const pending = problem.drop(review.pending);
			review = {
				view: review.view,
				pending,
				// Dropping can resolve or change others, so every problem is read again.
				problems: findViewProblems(pending, host.vocabulary())
			};
		},

		/** Opens the reviewed view once no broken reference is left. */
		confirmReview() {
			if (!review || review.problems.length > 0) return;
			host.apply(review.pending);
			openedId = review.view.id;
			review = null;
		},

		/** Leaves the question as it was. */
		cancelReview() {
			review = null;
		},

		/** Save as: stores the question on screen under a new name and opens it. */
		saveAs: (name: string) =>
			run('save', async () => {
				const view = await host.api.create(name, host.capture());
				replace(view);
				openedId = view.id;
			}),

		/** The explicit Update: overwrites the open view with the question on screen. */
		update: () =>
			run('save', async () => {
				if (openedId === null) return;
				replace(await host.api.update(openedId, { snapshot: host.capture() }));
			}),

		rename: (id: string, name: string) =>
			run('save', async () => {
				replace(await host.api.update(id, { name }));
			}),

		remove: (id: string) =>
			run('save', async () => {
				await host.api.remove(id);
				views = views.filter((view) => view.id !== id);
				if (openedId === id) openedId = null;
			})
	};
}

export type SavedViews = ReturnType<typeof createSavedViews>;
