import { describe, expect, it } from 'vitest';
import { PersonState, stripPersonParams } from './person-state.svelte.ts';

describe('stripPersonParams', () => {
	it('removes q, sel and worker and keeps every other parameter', () => {
		const params = new URLSearchParams('q=Ada&sel=w1&worker=w2&f=a:1&group=dept&hq=x');
		expect(stripPersonParams(params)).toBe(true);
		expect(params.toString()).toBe('f=a%3A1&group=dept&hq=x');
	});

	it('answers false when nothing person-specific is present', () => {
		const params = new URLSearchParams('f=a:1');
		expect(stripPersonParams(params)).toBe(false);
		expect(params.toString()).toBe('f=a%3A1');
	});
});

describe('PersonState', () => {
	it('keeps one partition per Worksite across lookups', () => {
		const person = new PersonState();
		person.forWorksite('a').workersSelectedId = 'w1';
		person.forWorksite('a').mapQuery = 'Ada';
		expect(person.forWorksite('a').workersSelectedId).toBe('w1');
		expect(person.forWorksite('a').mapQuery).toBe('Ada');
	});

	it('never leaks a selection into another Worksite', () => {
		const person = new PersonState();
		person.forWorksite('a').mapSelectedId = 'w1';
		expect(person.forWorksite('b').mapSelectedId).toBe('');
		expect(person.forWorksite('a').mapSelectedId).toBe('w1');
	});

	it('starts empty, as after a reload', () => {
		const partition = new PersonState().forWorksite('a');
		expect(partition.workersSelectedId).toBeNull();
		expect(partition.mapSelectedId).toBe('');
		expect(partition.mapQuery).toBe('');
	});

	it('gives a missing Worksite a private partition', () => {
		const person = new PersonState();
		person.forWorksite(null).mapQuery = 'x';
		expect(person.forWorksite(null).mapQuery).toBe('');
	});
});
