import { nodeRadius } from './map-style.ts';

/**
 * The dot-size key's largest circle, in screen pixels. The key keeps the map's relative dot
 * sizes but not the live zoom: drawn at the zoom, its width changed after the first fit and
 * reflowed the colour key beside it under names already placed. 6px is the largest dot at a
 * typical fitted zoom (about a quarter at 1024x640), so the key keeps its usual fitted size.
 */
export const DOT_KEY_LARGEST_RADIUS = 6;

/** The gap between one step's circle and the next, past its label. */
const STEP_GAP = 20;

export type DotKeyStep = { count: number; r: number; label: string; x: number };

/** Every count up to the cap at one fixed scale, spaced so the largest dots keep a gap. */
export function dotSizeKeyGeometry(): { steps: DotKeyStep[]; width: number; height: number } {
	const counts = [0, 1, 2, 3, 4, 5];
	const scale = DOT_KEY_LARGEST_RADIUS / nodeRadius(counts.at(-1)!);
	let x = 0;
	const steps = counts.map((count) => {
		const r = nodeRadius(count) * scale;
		const step = { count, r, label: count === 5 ? '5+' : String(count), x: x + r };
		x += 2 * r + STEP_GAP;
		return step;
	});
	const last = steps.at(-1)!;
	return {
		steps,
		width: Math.ceil(last.x + last.r + 22),
		height: Math.max(24, Math.ceil(2 * last.r) + 2)
	};
}
