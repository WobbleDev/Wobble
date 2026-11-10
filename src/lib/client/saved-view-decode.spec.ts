import { describe, expect, it } from 'vitest';
import { decodeSavedView, decodeSavedViews } from './saved-view-decode.ts';
import {
	mappingSnapshot,
	savedView,
	workersSnapshot
} from '#lib/features/saved-views/saved-view-fixtures.ts';

const workers = savedView('v1', 'Worker 07 view', workersSnapshot());
const mapping = savedView('v2', 'Map view', mappingSnapshot());
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('decoding a saved view', () => {
	it('reads both kinds exactly', () => {
		expect(decodeSavedView(clone(workers))).toEqual(workers);
		expect(decodeSavedView(clone(mapping))).toEqual(mapping);
		expect(decodeSavedViews({ views: [clone(workers), clone(mapping)] })).toHaveLength(2);
	});

	it('refuses a bad version, an unknown kind, an unknown field and incompatible references', () => {
		const badVersion = clone(workers);
		badVersion.snapshot.version = 2;
		const unknownKind = clone(workers) as unknown as Record<string, unknown>;
		(unknownKind.snapshot as Record<string, unknown>).kind = 'overview';
		unknownKind.kind = 'overview';
		const unknownField = clone(workers);
		(unknownField.snapshot.workers as unknown as Record<string, unknown>).search = 'ada';
		const personState = clone(mapping);
		(personState.snapshot.mapping as unknown as Record<string, unknown>).selectedId = 'w1';
		const wrongKind = { ...clone(workers), kind: 'mapping' };
		const badEnum = clone(mapping);
		(badEnum.snapshot.mapping as unknown as Record<string, unknown>).layout = 'isolated';
		const badRefs = clone(workers);
		(badRefs.snapshot.workers!.filters.population as unknown as Record<string, unknown>).missing =
			'role';
		const bothBodies = clone(workers);
		bothBodies.snapshot.mapping = clone(mapping.snapshot.mapping!);

		for (const value of [
			badVersion,
			unknownKind,
			unknownField,
			personState,
			wrongKind,
			badEnum,
			badRefs,
			bothBodies
		]) {
			expect(() => decodeSavedView(value)).toThrow(/invalid saved view/);
		}
		expect(() => decodeSavedViews({ views: 'nope' })).toThrow();
	});
});
