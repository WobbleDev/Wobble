import { describe, expect, it } from 'vitest';
import { assessmentColorFor } from '#lib/shared/workers/assessment.ts';
import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
import {
	pct,
	segmentFill,
	segments,
	entranceAnimationCountUp,
	cellShade,
	floorPlacement,
	heatRatio,
	segmentLabelTone,
	toneClass,
	showsSegmentCount,
	SHADE_KEY_STEPS
} from './overview-dashboard-presentation.ts';
import { readLayoutCss } from '#lib/testing/layout-css.ts';

/**
 * The dashboard's presentation rules live in one plain module, so the page
 * reads them instead of recomputing them. Each expectation below pins the
 * approved presentation value, not a recomputation of the implementation.
 */
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
	it('mixes the cool-slate heat into the panel from 6% to 58% of the ratio', () => {
		expect(cellShade(0)).toBe('var(--inset)');
		expect(cellShade(0.25)).toBe('color-mix(in srgb, var(--heat) 19%, var(--panel))');
		expect(cellShade(0.5)).toBe('color-mix(in srgb, var(--heat) 32%, var(--panel))');
		expect(cellShade(0.75)).toBe('color-mix(in srgb, var(--heat) 45%, var(--panel))');
		expect(cellShade(1)).toBe('color-mix(in srgb, var(--heat) 58%, var(--panel))');
	});
});

describe('heat ramp', () => {
	const css = readLayoutCss();
	const token = (selector: string, name: string) => {
		const start = css.indexOf(`${selector} {`);
		expect(start, selector).toBeGreaterThanOrEqual(0);
		const body = css.slice(start, css.indexOf('}', start));
		const value = body.match(new RegExp(`${name}:\\s*(#[a-fA-F0-9]{6})`))?.[1];
		expect(value, `${selector} ${name}`).toBeDefined();
		return value!;
	};
	const channels = (hex: string) =>
		[1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
	const mix = (heat: string, panel: string, percentage: number) =>
		channels(heat).map((channel, index) =>
			Math.round(channel * percentage + channels(panel)[index]! * (1 - percentage))
		);
	const luminance = (rgb: number[]) =>
		rgb
			.map((channel) => {
				const s = channel / 255;
				return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			})
			.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
	const contrastRatio = (a: number[], b: number[]) => {
		const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
		return (hi! + 0.05) / (lo! + 0.05);
	};

	it('declares the approved heat token in each theme', () => {
		expect(token(':root', '--heat')).toBe('#5d6f86');
		expect(token('.dark', '--heat')).toBe('#8aa0bb');
	});

	for (const theme of ['light', 'dark'] as const) {
		it(`keeps ink at 4.5:1 on the hottest ${theme} cell`, () => {
			const body = theme === 'light' ? ':root' : '.dark';
			const fill = mix(token(body, '--heat'), token(body, '--panel'), 0.58);
			expect(contrastRatio(fill, channels(token(body, '--ink')))).toBeGreaterThanOrEqual(4.5);
		});
	}
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

describe('entranceAnimationCountUp', () => {
	it('holds zero before the 60ms delay has passed', () => {
		expect(entranceAnimationCountUp(63, 0)).toBe(0);
		expect(entranceAnimationCountUp(63, 59)).toBe(0);
		expect(entranceAnimationCountUp(63, 60)).toBe(0);
	});

	it('is halfway at the 245ms midpoint', () => {
		expect(entranceAnimationCountUp(63, 245)).toBe(32);
	});

	it('reaches the final value at 430ms', () => {
		expect(entranceAnimationCountUp(63, 430)).toBe(63);
	});

	it('stays at the final value past the end of the run', () => {
		expect(entranceAnimationCountUp(63, 431)).toBe(63);
		expect(entranceAnimationCountUp(63, 2400)).toBe(63);
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
	it('prints white on every shipped bar fill: 3:1 on the default palette, 4.5:1 on the colour-blind one', () => {
		const css = readLayoutCss();
		const luminance = (hex: string) => {
			const channels = [1, 3, 5]
				.map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
				.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
			return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
		};
		const hexes = (token: string) => [
			...css.matchAll(new RegExp(`${token}:\\s*(#[a-fA-F0-9]{6})`, 'g')).map((match) => match[1])
		];
		for (const assessment of assessed) {
			const key = assessment.toLowerCase();
			// The light default draws its dot colour; the dark default and the colour-blind
			// palette (both themes) draw their `-bar` fills, declared in that order.
			const dots = hexes(`--assess-${key}`);
			const bars = hexes(`--assess-${key}-bar`);
			expect(bars, `${assessment} bar fills`).toHaveLength(2);
			const fills = [
				['default Light', dots[0], 3],
				['default Dark', bars[0], 3],
				['colour-blind', bars[1], 4.5]
			] as const;
			expect(segmentLabelTone(assessment)).toBe('white');
			for (const [context, fill, floor] of fills) {
				const ratio = 1.05 / (luminance(fill) + 0.05);
				expect(ratio, `${assessment} ${context}`).toBeGreaterThanOrEqual(floor);
			}
		}
	});
	it('keeps Unassessed on theme ink', () => {
		expect(segmentLabelTone('Unassessed')).toBe('default');
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

	it('draws the dark theme and the colour-blind palette on the bar fills', () => {
		expect(segmentFill('Leader', 'dark')).toBe('var(--assess-leader-bar)');
		expect(segmentFill('Leader', 'light', 'colorblind')).toBe('var(--assess-leader-bar)');
		expect(segmentFill('Leader', 'dark', 'colorblind')).toBe('var(--assess-leader-bar)');
	});
});
