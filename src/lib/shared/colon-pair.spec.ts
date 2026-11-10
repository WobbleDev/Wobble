import { describe, expect, it } from 'vitest';
import { encodeColonPair, parseColonPair } from './colon-pair.ts';

describe('the <id>:<value> shape', () => {
	it('reads the id before the first colon and everything after it as the value', () => {
		expect(parseColonPair('department:Back of House')).toEqual({
			id: 'department',
			value: 'Back of House'
		});
	});

	it('keeps a colon inside the value rather than splitting on it', () => {
		expect(parseColonPair('shifts:Dinner:late')).toEqual({ id: 'shifts', value: 'Dinner:late' });
	});

	it('refuses a shape with no id, no colon, or no value', () => {
		expect(parseColonPair(':Back of House')).toBeNull();
		expect(parseColonPair('department')).toBeNull();
		expect(parseColonPair('department:')).toBeNull();
		expect(parseColonPair('')).toBeNull();
	});

	it('joins with one colon and round-trips', () => {
		expect(encodeColonPair('department', 'Back of House')).toBe('department:Back of House');
		expect(parseColonPair(encodeColonPair('shifts', 'Dinner'))).toEqual({
			id: 'shifts',
			value: 'Dinner'
		});
	});
});
