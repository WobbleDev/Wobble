import { describe, expect, it } from 'vitest';
import { cohortExhausted, cohortPosition } from './worker-cohort.ts';

const all = () => true;

describe('cohortPosition', () => {
	it('walks the snapshot and disables both boundaries', () => {
		expect(cohortPosition(['a', 'b', 'c'], 'a', all)).toEqual({
			previousId: null,
			nextId: 'b',
			position: 1,
			total: 3
		});
		expect(cohortPosition(['a', 'b', 'c'], 'c', all)).toMatchObject({
			previousId: 'b',
			nextId: null,
			position: 3
		});
	});

	it('skips deleted members in both directions', () => {
		const live = (id: string) => id !== 'b' && id !== 'c';
		expect(cohortPosition(['a', 'b', 'c', 'd'], 'a', live)).toMatchObject({
			nextId: 'd',
			total: 2
		});
		expect(cohortPosition(['a', 'b', 'c', 'd'], 'd', live)).toMatchObject({ previousId: 'a' });
	});

	it('keeps neighbours for a member that is no longer live (edited out of the table)', () => {
		const live = (id: string) => id !== 'b';
		expect(cohortPosition(['a', 'b', 'c'], 'b', live)).toEqual({
			previousId: 'a',
			nextId: 'c',
			position: null,
			total: 2
		});
	});

	it('offers no step for a Worker outside the snapshot', () => {
		expect(cohortPosition(['a', 'b'], 'new', all)).toEqual({
			previousId: null,
			nextId: null,
			position: null,
			total: 2
		});
	});
});

describe('cohortExhausted', () => {
	it('is true only for a captured cohort with no live member', () => {
		expect(cohortExhausted([], all)).toBe(false);
		expect(cohortExhausted(['a'], () => false)).toBe(true);
		expect(cohortExhausted(['a', 'b'], (id) => id === 'b')).toBe(false);
	});
});
