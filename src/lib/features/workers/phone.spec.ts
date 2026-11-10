import { describe, expect, it } from 'vitest';
import { formatPhoneInput, normalizePhone } from './phone.ts';

describe('formatPhoneInput', () => {
	it('shapes progressive typing, ignores letters, and stops at 10 digits', () => {
		expect(formatPhoneInput('')).toBe('');
		expect(formatPhoneInput('555')).toBe('(555)');
		expect(formatPhoneInput('555010')).toBe('(555) 010');
		expect(formatPhoneInput('5550100100')).toBe('(555) 010-0100');
		expect(formatPhoneInput('5a5b5')).toBe('(555)');
		expect(formatPhoneInput('55501001009')).toBe('(555) 010-0100');
	});

	it('lands punctuated and prefixed pastes in the same shape', () => {
		for (const pasted of [
			'555.010.0100',
			'555-010-0100',
			'(555) 010-0100',
			'+1 555 010 0100',
			'1-555-010-0100',
			'5550100100',
			'55501001000'
		]) {
			expect(formatPhoneInput(pasted), pasted).toBe('(555) 010-0100');
		}
	});
});

describe('normalizePhone', () => {
	it('stores clean numbers, refuses incomplete ones, and keeps empty empty', () => {
		expect(normalizePhone('')).toBe('');
		expect(normalizePhone('5550100100')).toBe('(555) 010-0100');
		expect(normalizePhone('5550100')).toBeNull();
	});
});
