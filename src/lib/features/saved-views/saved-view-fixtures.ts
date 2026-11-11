/** Synthetic views and vocabulary shared by the saved-view specs. */
import type {
	SavedView,
	SavedViewMapping,
	SavedViewSnapshot,
	SavedViewWorkers
} from '#lib/domain-vocabulary.ts';
import { answerIdOf, attributeFixture } from '#lib/testing/mapping/answer-fixtures.ts';
import type { ViewVocabulary } from './saved-view-references.ts';

export const role = attributeFixture({
	id: 'role',
	name: 'Role',
	kind: 'category',
	options: ['Steward', 'Member']
});
export const shift = attributeFixture({
	id: 'shift',
	name: 'Shift',
	kind: 'tag',
	options: ['Day', 'Night']
});

export const vocabulary: ViewVocabulary = {
	attributes: [role, shift],
	languages: [
		{ id: 'lang-a', name: 'Language A' },
		{ id: 'lang-b', name: 'Language B' }
	],
	agitations: [{ id: 'agitation-a', text: 'Agitation A' }]
};

export function workersView(overrides: Partial<SavedViewWorkers> = {}): SavedViewWorkers {
	return {
		filters: {
			population: { answers: {}, exactAnswers: {}, missing: [] },
			agitations: [],
			languages: [],
			assessments: []
		},
		sort: [{ column: 'name', descending: false }],
		hiddenColumns: [],
		order: [],
		...overrides
	};
}

export function mappingView(overrides: Partial<SavedViewMapping> = {}): SavedViewMapping {
	return {
		grouping: { group: '', subGroup: '' },
		detail: { expanded: [], expandedSub: [] },
		layout: 'grouped',
		population: { answers: {}, exactAnswers: {}, missing: [] },
		visibility: { assessments: [], values: {}, languages: [] },
		highlight: { query: '' },
		...overrides
	};
}

export const workersSnapshot = (view: SavedViewWorkers = workersView()): SavedViewSnapshot => ({
	version: 1,
	kind: 'workers',
	workers: view
});

export const mappingSnapshot = (view: SavedViewMapping = mappingView()): SavedViewSnapshot => ({
	version: 1,
	kind: 'mapping',
	mapping: view
});

export function savedView(id: string, name: string, snapshot: SavedViewSnapshot): SavedView {
	return {
		id,
		name,
		kind: snapshot.kind,
		snapshot,
		createdAt: '2026-11-09T00:00:00.000Z',
		updatedAt: '2026-11-09T00:00:00.000Z'
	};
}

export const stewardId = answerIdOf('role', 'Steward');
