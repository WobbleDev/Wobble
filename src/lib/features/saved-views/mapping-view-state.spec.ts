import { describe, expect, it } from 'vitest';
import { snapshotToSearchParams } from '#lib/features/mapping/map-view-snapshot.ts';
import { captureMappingView, mappingViewToSnapshot } from './mapping-view-state.ts';
import { mappingView, stewardId } from './saved-view-fixtures.ts';

describe('the map as a view', () => {
	it('round-trips grouping, detail, layout, population, visibility and Highlight', () => {
		const view = mappingView({
			grouping: { group: 'role', subGroup: 'shift' },
			detail: { expanded: [stewardId], expandedSub: ['shift~Day'] },
			layout: 'free',
			population: { answers: { role: [stewardId] }, exactAnswers: {}, missing: ['shift'] },
			visibility: {
				assessments: ['Leader'],
				values: { shift: ['shift~Night'] },
				languages: ['lang-a']
			},
			highlight: { query: '{"v":1,"m":"all","r":[]}' }
		});
		expect(captureMappingView(mappingViewToSnapshot(view, false))).toEqual(view);
	});

	it('keeps the organizer’s Isolate and writes nothing person-specific to the address', () => {
		const snapshot = mappingViewToSnapshot(mappingView(), true);
		expect(snapshot.isolated).toBe(true);
		const view = captureMappingView(snapshot);
		expect(Object.keys(view).sort()).toEqual([
			'detail',
			'grouping',
			'highlight',
			'layout',
			'population',
			'visibility'
		]);
		const params = snapshotToSearchParams(mappingViewToSnapshot(mappingView(), false));
		for (const person of ['q', 'sel', 'worker', 'iso']) expect(params.has(person)).toBe(false);
	});
});
