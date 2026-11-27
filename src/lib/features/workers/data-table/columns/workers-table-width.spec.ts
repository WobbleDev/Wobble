import { describe, expect, it } from 'vitest';
import {
	ASSESSMENT_MIN_REM,
	CONTENT_SHRINK_MIN_REM,
	WORKERS_SELECT_REM,
	contentColumnNeedRem,
	contentColumnRem,
	mobileContentColumnRem,
	workersColumnMinRem,
	workersColumnRem,
	workersMinWidth,
	workersTableWidth,
	NO_GROW_SHARE_REM,
	workersVisibleRem,
	shrinkFactor
} from './workers-table-width.ts';

describe('contentColumnRem', () => {
	it('sizes a column to its longest option within a floor and a ceiling', () => {
		expect(contentColumnRem([])).toBe(6);
		expect(contentColumnRem(['Spanish'])).toBeLessThan(contentColumnRem(['Front of House']));
		expect(contentColumnRem(['x'.repeat(200)])).toBe(15);
	});
});

describe('contentColumnNeedRem', () => {
	it('keeps a wide table header whole and its longest single value readable', () => {
		expect(contentColumnNeedRem('Safety Certifications', [])).toBe(14.75);
		expect(contentColumnNeedRem('Department', ['Front of House'])).toBe(9.25);
		expect(
			contentColumnNeedRem('Safety Certifications', ['First aid'], {
				emptyLabel: 'No Safety Certifications'
			})
		).toBe(14.75);
	});

	it('sizes Assessment for its longest label and swatch, and Multi-Select for two chips', () => {
		expect(contentColumnNeedRem('Assessment', ['Supporter', 'Disengaged'], { swatch: true })).toBe(
			9.25
		);
		expect(contentColumnNeedRem('Shifts', ['Dinner', 'Brunch'], { multi: true })).toBe(9.25);
	});

	it('caps a value that is too long for the widest allowed column', () => {
		expect(contentColumnNeedRem('Notes', ['x'.repeat(40)])).toBe(15);
	});
});

describe('mobileContentColumnRem', () => {
	it('keeps the full header beside two 44px controls', () => {
		expect(mobileContentColumnRem('Assessment', ['Supporter'], { swatch: true })).toBe(10.5);
		expect(mobileContentColumnRem('Languages', ['Spanish'], { multi: true })).toBe(10);
		expect(mobileContentColumnRem('Department', ['Front of House'])).toBe(10.5);
	});

	it('wins over the compact content width only when the full header needs it', () => {
		expect(mobileContentColumnRem('Role', ['Server'])).toBe(7.5);
		expect(mobileContentColumnRem('Role', ['x'.repeat(40)])).toBe(15);
	});
});

describe('workersColumnRem', () => {
	it('gives the pinned checkbox the shared constant and unknown ids their content width', () => {
		expect(workersColumnRem('selection', {})).toBe(WORKERS_SELECT_REM);
		expect(workersColumnRem('dept', { dept: 9 })).toBe(9);
	});
});

describe('workersTableWidth', () => {
	it('floors at the minimum sum', () => {
		const ids = ['selection', 'name', 'assessment', 'dept'] as const;
		const content = { dept: 8 };
		expect(workersColumnRem('dept', content)).toBe(8);
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

	it('floors seven long Attribute columns past a 1024px frame', () => {
		const labels = [
			'Safety Certifications',
			'Availability',
			'Tenure',
			'Role',
			'Station',
			'Shifts',
			'Mentor'
		];
		const ids = ['selection', 'name', 'assessment', ...labels.map((_, index) => `attr-${index}`)];
		const content = Object.fromEntries(labels.map((_, index) => [`attr-${index}`, 14]));
		const minRem: Record<string, number> = {
			assessment: contentColumnNeedRem('Assessment', ['Disengaged'], { swatch: true })
		};
		const contentMinRem = labels.reduce((sum, label, index) => {
			const need = contentColumnNeedRem(label, [`${label} answer`]);
			minRem[`attr-${index}`] = need;
			return sum + need;
		}, 0);
		const totalMinRem = WORKERS_SELECT_REM + 10 + minRem.assessment + contentMinRem;
		expect(totalMinRem * 16).toBeGreaterThan(1024);
		expect(workersMinWidth(ids, content, minRem)).toBe(
			`calc(var(--workers-table-name-w) + ${totalMinRem - 10}rem)`
		);
	});
});

describe('workersColumnMinRem', () => {
	it('keeps pinned columns fixed and floors shrinkable ones for a table that fits', () => {
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
	it('keeps the rem widths and minimums and sums only the growing columns', () => {
		const { contentRem, minRem, growRem } = workersVisibleRem([
			{ id: 'name', width: '12rem' },
			{ id: 'assessment', width: '9rem', minWidth: '9rem', grow: true },
			{ id: 'languages', width: '7.5rem', minWidth: '5rem', grow: true },
			{ id: 'notes', width: 'auto' }
		]);
		expect(contentRem).toEqual({ name: 12, assessment: 9, languages: 7.5 });
		expect(minRem).toEqual({ assessment: 9, languages: 5 });
		expect(growRem).toBe(16.5);
	});

	it('leaves out columns without a rem width and reports no grow when none grows', () => {
		const { contentRem, minRem, growRem } = workersVisibleRem([
			{ id: 'selection', width: '2.75rem' },
			{ id: 'extra', grow: true }
		]);
		expect(contentRem).toEqual({ selection: 2.75 });
		expect(minRem).toEqual({});
		expect(growRem).toBe(0);
	});

	it('names the fallback grow share as a non-zero divisor', () => {
		expect(NO_GROW_SHARE_REM).toBe(1);
	});
});
