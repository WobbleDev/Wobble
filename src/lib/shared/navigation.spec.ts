import type { ResolvedPathname } from '$app/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceCurrentUrl, withQuery, withSearch } from './navigation.ts';

const replaceState = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ replaceState }));

const path = (value: string) => value as ResolvedPathname;

describe('withQuery', () => {
	it('returns the path unchanged when there are no params', () => {
		expect(withQuery(path('/overview'), {})).toBe('/overview');
	});

	it('appends one param after a question mark', () => {
		expect(withQuery(path('/overview'), { setup: '1' })).toBe('/overview?setup=1');
	});

	it('joins several params with ampersands in insertion order', () => {
		expect(withQuery(path('/workers'), { f: 'assessment:Leader', sort: 'name' })).toBe(
			'/workers?f=assessment%3ALeader&sort=name'
		);
	});

	it('encodes keys and values the way encodeURIComponent does', () => {
		expect(withQuery(path('/workers'), { 'a key': 'b&c d' })).toBe('/workers?a%20key=b%26c%20d');
	});
});
describe('withSearch', () => {
	it('returns the path unchanged when there are no params', () => {
		expect(withSearch(path('/workers'), new URLSearchParams())).toBe('/workers');
	});

	it('keeps repeated keys and their encoded values', () => {
		const params = new URLSearchParams();
		params.append('f', 'location:store-a');
		params.append('f', 'job:cashier');
		params.append('missing', 'shift');
		expect(withSearch(path('/workers'), params)).toBe(
			'/workers?f=location%3Astore-a&f=job%3Acashier&missing=shift'
		);
	});
});

describe('replaceCurrentUrl', () => {
	beforeEach(() => {
		vi.stubGlobal('window', { location: { href: 'http://app.test/workers?worker=7&f=a' } });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		replaceState.mockReset();
	});

	it('replaces the current address with the edited search params', () => {
		replaceCurrentUrl((params) => params.set('f', 'b'));
		const [url, state] = replaceState.mock.calls[0];
		expect(String(url)).toBe('http://app.test/workers?worker=7&f=b');
		expect(state).toEqual({});
	});

	it('keeps params the edit does not touch, such as the selected Worker', () => {
		replaceCurrentUrl((params) => params.delete('f'));
		expect(String(replaceState.mock.calls[0][0])).toBe('http://app.test/workers?worker=7');
	});

	it('passes the given history state through', () => {
		const kept = { panel: 'open' };
		replaceCurrentUrl(() => {}, kept);
		expect(replaceState.mock.calls[0][1]).toBe(kept);
	});

	it('leaves the address alone when the edit returns false', () => {
		expect(replaceCurrentUrl(() => false)).toBe(false);
		expect(replaceState).not.toHaveBeenCalled();
	});
});
