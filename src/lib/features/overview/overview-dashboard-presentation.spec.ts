import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessmentColorFor } from '#lib/shared/assessment.ts';
import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
import {
	pct,
	segmentFill,
	segments,
	arrivalCountUp,
	cellShade,
	cellTone,
	floorPlacement,
	heatRatio,
	segmentLabelTone,
	toneClass,
	showsSegmentCount,
	SHADE_KEY_STEPS
} from './overview-dashboard-presentation.ts';

/**
 * The dashboard's presentation rules live in one plain module, so the page
 * reads them instead of recomputing them. Each expectation below pins the
 * approved presentation value, not a recomputation of the implementation.
 */
describe('cellTone', () => {
	it('uses theme-specific thresholds for light and dark cell fills', () => {
		expect(cellTone(0.85)).toBe('white');
		expect(cellTone(0.81)).toBe('white');
		expect(cellTone(0.8)).toBe('black');
		expect(cellTone(0.36)).toBe('black');
		expect(cellTone(0.35)).toBe('default');
		expect(cellTone(0)).toBe('default');
		expect(cellTone(0.5, 'dark')).toBe('white');
		expect(cellTone(0.66, 'dark')).toBe('white');
		expect(cellTone(0.67, 'dark')).toBe('black');
	});
});

describe('toneClass', () => {
	it('names the white and black classes and falls back otherwise', () => {
		expect(toneClass('white', '')).toBe('text-white');
		expect(toneClass('black', '')).toBe('text-black');
		expect(toneClass('default', '')).toBe('');
		expect(toneClass('white', 'text-ink')).toBe('text-white');
		expect(toneClass('black', 'text-ink')).toBe('text-black');
		expect(toneClass('default', 'text-ink')).toBe('text-ink');
	});
});

describe('cellShade', () => {
	it('mixes the secondary ink into the panel at 85% of the ratio', () => {
		expect(cellShade(0)).toBe('var(--inset)');
		expect(cellShade(0.5)).toBe('color-mix(in oklab, var(--ink-2) 42.5%, var(--panel))');
		expect(cellShade(1)).toBe('color-mix(in oklab, var(--ink-2) 85%, var(--panel))');
	});
});

describe('shade key', () => {
	it('runs from none to the maximum in quarter steps', () => {
		expect(SHADE_KEY_STEPS).toEqual([0, 0.25, 0.5, 0.75, 1]);
	});
});

describe('showsSegmentCount', () => {
	it('names a segment at 5% of the bar and hides one below it', () => {
		expect(showsSegmentCount(1, 20)).toBe(true);
		expect(showsSegmentCount(1, 21)).toBe(false);
		expect(showsSegmentCount(0, 0)).toBe(false);
	});
});

describe('floorPlacement', () => {
	it('rests at 1.4x the frame height, centred at 77%/69%, scale 1 about the lower right', () => {
		expect(floorPlacement(1000, 800, false)).toEqual({
			size: 1120,
			centerX: 770,
			centerY: 552,
			scale: 1,
			origin: 'right bottom'
		});
	});

	it('grows in place when focused', () => {
		expect(floorPlacement(1000, 800, true)).toEqual({
			size: 1120,
			centerX: 770,
			centerY: 552,
			scale: 1.12,
			origin: 'right bottom'
		});
	});

	it('collapses a zero-size frame to a point', () => {
		expect(floorPlacement(0, 0, false)).toEqual({
			size: 0,
			centerX: 0,
			centerY: 0,
			scale: 1,
			origin: 'right bottom'
		});
	});
});

describe('arrivalCountUp', () => {
	it('holds zero before the 60ms delay has passed', () => {
		expect(arrivalCountUp(63, 0)).toBe(0);
		expect(arrivalCountUp(63, 59)).toBe(0);
		expect(arrivalCountUp(63, 60)).toBe(0);
	});

	it('is halfway at the 245ms midpoint', () => {
		expect(arrivalCountUp(63, 245)).toBe(32);
	});

	it('reaches the final value at 430ms', () => {
		expect(arrivalCountUp(63, 430)).toBe(63);
	});

	it('stays at the final value past the end of the run', () => {
		expect(arrivalCountUp(63, 431)).toBe(63);
		expect(arrivalCountUp(63, 2400)).toBe(63);
	});
});

describe('heatRatio', () => {
	it('divides the count by the table maximum', () => {
		expect(heatRatio(3, 12)).toBe(0.25);
	});

	it('is zero when the table maximum is zero', () => {
		expect(heatRatio(5, 0)).toBe(0);
		expect(heatRatio(0, 0)).toBe(0);
	});
});

describe('segmentLabelTone', () => {
	const assessed: AssessmentOption[] = ['Leader', 'Activist', 'Supporter', 'Disengaged', 'Hostile'];
	it('meets4.5:1 on every shipped theme and Assessment palette fill', () => {
		const css = readFileSync(new URL('../../../routes/layout.css', import.meta.url), 'utf8');
		const luminance = (hex: string) => {
			const channels = [1, 3, 5]
				.map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
				.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
			return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
		};
		const contexts = [
			['light', 'default'],
			['dark', 'default'],
			['light', 'colorblind'],
			['dark', 'colorblind']
		] as const;
		for (const assessment of assessed) {
			const fills = [
				...css.matchAll(
					new RegExp(`--assess-${assessment.toLowerCase()}:\\s*(#[a-fA-F0-9]{6})`, 'g')
				)
			].map((match) => match[1]);
			expect(fills).toHaveLength(contexts.length);
			contexts.forEach(([theme, palette], index) => {
				const tone = segmentLabelTone(assessment, theme, palette);
				const background = luminance(fills[index]);
				const foreground = tone === 'white' ? 1 : 0;
				const ratio =
					(Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
				expect(ratio, `${assessment} ${theme} ${palette} ${tone}`).toBeGreaterThanOrEqual(4.5);
			});
		}
	});
	it('keeps Unassessed on theme ink in both themes', () => {
		expect(segmentLabelTone('Unassessed', 'light')).toBe('default');
		expect(segmentLabelTone('Unassessed', 'dark')).toBe('default');
	});
});

describe('bar helpers', () => {
	it('rounds a rate to a whole percent', () => {
		expect(pct(0.456)).toBe('46%');
		expect(pct(0)).toBe('0%');
		expect(pct(1)).toBe('100%');
	});

	it('lists only the non-empty segments, in Assessment order with Unassessed last', () => {
		const counts = {
			Leader: 0,
			Supporter: 2,
			Unassessed: 1,
			Activist: 3,
			Hostile: 0,
			Disengaged: 0
		} as unknown as Record<AssessmentOption, number>;
		const ordered = segments(counts).map((segment) => segment.option);
		expect(ordered.at(-1)).toBe('Unassessed');
		expect(ordered).toEqual(expect.arrayContaining(['Supporter', 'Activist']));
		expect(ordered).not.toContain('Leader');
	});

	it('fills Unassessed with the neutral mix and other options with their colour', () => {
		expect(segmentFill('Unassessed')).toContain('--assessment-unassessed');
		expect(segmentFill('Leader')).toBe(assessmentColorFor('Leader'));
	});
});
