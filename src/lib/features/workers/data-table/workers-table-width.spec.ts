import { describe, expect, it } from 'vitest';
import {
	ASSESSMENT_MIN_REM,
	CONTENT_SHRINK_MIN_REM,
	WORKERS_SELECT_REM,
	contentColumnRem,
	workersColumnMinRem,
	workersColumnRem,
	workersMinWidth,
	workersPreferredWidth,
	workersTableWidth,
	NO_GROW_SHARE_REM,
	workersVisibleRem,
	shrinkFactor
} from './workers-table-width.ts';

describe('contentColumnRem', () => {
	it('sizes a column to its longest option within a floor and a ceiling', () => {
		expect(contentColumnRem([])).toBe(6);
		expect(contentColumnRem(['Spanish'])).toBeLessThan(contentColumnRem(['Front of House']));
		expect(contentColumnRem(['x'.repeat(200)])).toBe(14);
	});
});

describe('workersColumnRem', () => {
	it('gives the pinned checkbox the shared constant and unknown ids their content width', () => {
		expect(workersColumnRem('selection', {})).toBe(WORKERS_SELECT_REM);
		expect(workersColumnRem('dept', { dept: 9 })).toBe(9);
	});
});

describe('workersTableWidth', () => {
	it('floors at the minimum sum while the preferred sum covers the full widths', () => {
		const ids = ['selection', 'name', 'assessment', 'dept'] as const;
		const content = { dept: 8 };
		expect(workersPreferredWidth([...ids], content)).toBe(
			'calc(var(--workers-table-name-w) + 19.75rem)'
		);
		expect(workersMinWidth([...ids], content)).toBe('calc(var(--workers-table-name-w) + 13.75rem)');
		expect(workersTableWidth([...ids], content)).toBe(
			'max(100%, calc(var(--workers-table-name-w) + 13.75rem))'
		);
	});

	it('shrinks when columns are hidden', () => {
		expect(workersTableWidth(['selection', 'name'], {})).toBe(
			'max(100%, calc(var(--workers-table-name-w) + 2.75rem))'
		);
	});
});

describe('workersColumnMinRem', () => {
	it('keeps pinned columns fixed and floors shrinkable ones', () => {
		expect(workersColumnMinRem('selection', WORKERS_SELECT_REM)).toBe(WORKERS_SELECT_REM);
		expect(workersColumnMinRem('name', 10)).toBe(10);
		expect(workersColumnMinRem('assessment', 9)).toBe(ASSESSMENT_MIN_REM);
		expect(workersColumnMinRem('dept', 8)).toBe(CONTENT_SHRINK_MIN_REM);
		expect(workersColumnMinRem('dept', 4)).toBe(4);
	});
});

describe('shrinkFactor', () => {
	it('clamps below the minimum and above the preferred sum', () => {
		expect(shrinkFactor(100, 200, 400)).toBe(0);
		expect(shrinkFactor(200, 200, 400)).toBe(0);
		expect(shrinkFactor(300, 200, 400)).toBe(0.5);
		expect(shrinkFactor(400, 200, 400)).toBe(1);
		expect(shrinkFactor(500, 200, 400)).toBe(1);
	});

	it('rests at full width when the range is degenerate', () => {
		expect(shrinkFactor(100, 200, 200)).toBe(1);
		expect(shrinkFactor(100, 200, 100)).toBe(1);
	});
});

describe('workersVisibleRem', () => {
	it('keeps the rem widths and sums only the growing columns', () => {
		const { contentRem, growRem } = workersVisibleRem([
			{ id: 'name', width: '12rem' },
			{ id: 'assessment', width: '9rem', grow: true },
			{ id: 'languages', width: '7.5rem', grow: true },
			{ id: 'notes', width: 'auto' }
		]);
		expect(contentRem).toEqual({ name: 12, assessment: 9, languages: 7.5 });
		expect(growRem).toBe(16.5);
	});

	it('leaves out columns without a rem width and reports no grow when none grows', () => {
		const { contentRem, growRem } = workersVisibleRem([
			{ id: 'selection', width: '2.75rem' },
			{ id: 'extra', grow: true }
		]);
		expect(contentRem).toEqual({ selection: 2.75 });
		expect(growRem).toBe(0);
	});

	it('names the fallback grow share as a non-zero divisor', () => {
		expect(NO_GROW_SHARE_REM).toBe(1);
	});
});
