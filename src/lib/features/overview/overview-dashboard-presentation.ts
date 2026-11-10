import { assessedOptions, type AssessmentOption } from '#lib/domain-vocabulary.ts';
import { assessmentColorFor } from '#lib/shared/assessment.ts';

/**
 * The Overview dashboard's presentation rules: how a matrix cell's holder count
 * becomes a heat ratio, a shade and a text tone, when a bar segment names its
 * count, and where the bullseye floor rests. Pure and DOM-free so the page
 * reads them instead of recomputing them; asserted in the spec beside this
 * module.
 */

/** A cell's share of the table maximum, or 0 when the table is empty. */
export function heatRatio(count: number, max: number): number {
	return max === 0 ? 0 : count / max;
}

/** A cell's text tone: white on the hottest cells, black above the middle, otherwise the default ink. */
export type CellTone = 'white' | 'black' | 'default';

/** The only origin the floor placement takes: the lower-right corner it grows about. */
export type FloorOrigin = 'right bottom';

/** Zero holders take the neutral inset; positive counts mix secondary ink into the panel at 85% of heat. */
export function cellShade(ratio: number): string {
	if (ratio === 0) return 'var(--inset)';
	return `color-mix(in oklab, var(--ink-2) ${ratio * 85}%, var(--panel))`;
}

/** The shade key's stops, from none to the table maximum. */
export const SHADE_KEY_STEPS = [0, 0.25, 0.5, 0.75, 1];

/** The count-up waits 60ms before starting, so the first dots flicker on first. */
const ARRIVAL_COUNTUP_DELAY_MS = 60;

/** The count-up reaches the final value 370ms after it starts, at 430ms. */
const ARRIVAL_COUNTUP_SPAN_MS = 370;

/**
 * The Overall support figure mid-arrival: the final percentage scaled by the
 * run's elapsed time along the support band's timing curve, clamped to the
 * final value once the run passes it. Moved here from the removed summary
 * column's support band, so the dashboard reads it instead of recomputing it.
 */
export function arrivalCountUp(percentage: number, elapsedMs: number): number {
	const progress = (elapsedMs - ARRIVAL_COUNTUP_DELAY_MS) / ARRIVAL_COUNTUP_SPAN_MS;
	return Math.round(percentage * Math.min(1, Math.max(0, progress)));
}

/** A bar segment names its count only at 5% of the bar or above. */
export function showsSegmentCount(count: number, total: number): boolean {
	return total > 0 && count / total >= 0.05;
}

/** Where the bullseye floor rests in its frame: its size, centre, scale and scale origin. */
export interface FloorPlacement {
	size: number;
	centerX: number;
	centerY: number;
	scale: number;
	origin: FloorOrigin;
}

/**
 * The floor's placement for a frame: 1.4x the frame's height, centred at 77%
 * of its width and 69% of its height, at rest scale, growing in place about
 * the lower-right corner when focused.
 */
export function floorPlacement(
	frameWidth: number,
	frameHeight: number,
	focused: boolean
): FloorPlacement {
	return {
		size: frameHeight * 1.4,
		centerX: frameWidth * 0.77,
		centerY: frameHeight * 0.69,
		scale: focused ? 1.12 : 1,
		origin: 'right bottom'
	};
}

/** The theme a tone is chosen for: the fills' lightness differs per theme. */
export type DashboardTheme = 'light' | 'dark';

/**
 * A matrix cell's text tone from its heat: light-theme cells switch to white
 * above 0.80, while dark-theme cells use black above 0.66. Below those
 * thresholds the middle range uses black in light theme and white in the dark-theme middle range; the lowest dark cells keep default ink.
 */
export function cellTone(ratio: number, theme: DashboardTheme = 'light'): CellTone {
	if (theme === 'dark') return ratio > 0.66 ? 'black' : ratio > 0.35 ? 'white' : 'default';
	if (ratio > 0.8) return 'white';
	if (ratio > 0.35) return 'black';
	return 'default';
}

/** Choose label ink for the shipped Assessment fills without changing their meaning or hue. */
export function segmentLabelTone(
	assessment: AssessmentOption,
	theme: DashboardTheme = 'light',
	palette: 'default' | 'colorblind' = 'default'
): CellTone {
	if (assessment === 'Unassessed') return 'default';
	if (
		palette === 'colorblind' &&
		((theme === 'light' && assessment === 'Leader') ||
			(theme === 'dark' && assessment === 'Supporter'))
	)
		return 'white';
	return 'black';
}

/**
 * A tone's text class: a white or black tone names its class, any other tone
 * falls back to the caller's default — the matrix cells' inherited ink, the bar
 * segments' theme ink.
 */
export function toneClass(tone: CellTone, fallback: string): string {
	return tone === 'white' ? 'text-white' : tone === 'black' ? 'text-black' : fallback;
}

/** The Assessment order the bars and the Support segments read, Unassessed last. */
export const assessmentOrder: AssessmentOption[] = [...assessedOptions, 'Unassessed'];

/** A rate as a whole-percent label. */
export function pct(rate: number): string {
	return Math.round(rate * 100) + '%';
}

/** The non-empty segments of a count record, in Assessment order. */
export function segments(
	counts: Record<AssessmentOption, number>
): { option: AssessmentOption; count: number }[] {
	return assessmentOrder
		.filter((option) => counts[option] > 0)
		.map((option) => ({ option, count: counts[option] }));
}

/** A segment's fill: the Assessment colour, or Unassessed's neutral mix into the panel. */
export function segmentFill(option: AssessmentOption): string {
	return option === 'Unassessed'
		? 'color-mix(in oklab, var(--assessment-unassessed) 35%, var(--panel))'
		: assessmentColorFor(option);
}
