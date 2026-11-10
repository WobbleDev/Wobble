import { describe, expect, it } from 'vitest';
import { panelMode } from './panel-mode.ts';

describe('panelMode', () => {
	it('shows the summary while any row is checked, open Worker or not', () => {
		expect(panelMode(3, true)).toBe('summary');
		expect(panelMode(1, false)).toBe('summary');
	});

	it('returns to the open Worker when the selection clears', () => {
		expect(panelMode(0, true)).toBe('worker');
	});

	it('shows the empty hint with nothing checked and nothing open', () => {
		expect(panelMode(0, false)).toBe('empty');
	});
});
