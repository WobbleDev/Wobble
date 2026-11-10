import { describe, expect, it } from 'vitest';
import { normalizeForMatch } from './text.ts';

describe('normalizeForMatch', () => {
	it('trims surrounding spaces and lowercases', () => {
		expect(normalizeForMatch('  Hello World  ')).toBe('hello world');
	});

	it('trims tabs and newlines as well as spaces', () => {
		expect(normalizeForMatch('\t Name \n')).toBe('name');
	});

	it('keeps whitespace inside the text', () => {
		expect(normalizeForMatch('  Ann   Lee ')).toBe('ann   lee');
	});

	it('returns an empty string for empty input', () => {
		expect(normalizeForMatch('')).toBe('');
	});

	it('returns an empty string for whitespace-only input', () => {
		expect(normalizeForMatch('   \t ')).toBe('');
	});

	it('lowercases non-ASCII letters', () => {
		expect(normalizeForMatch('ÉCOLE')).toBe('école');
	});
});
