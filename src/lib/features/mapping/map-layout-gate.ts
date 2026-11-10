/** The root's `--density-scale` for each density; keep in step with src/routes/layout.css. */
export const densityScales = { compact: 0.9375, standard: 1, comfortable: 1.0625 } as const;

/** The browser's default root font size, which the stylesheet's `100%` resolves against. */
const baseRootFontPx = 16;

/** The root's computed font size for a density and text scale, as `layout.css` composes them. */
export function expectedRootFontPx(
	density: keyof typeof densityScales,
	textScale = 1,
	basePx = baseRootFontPx
): number {
	return basePx * densityScales[density] * textScale;
}

/**
 * Decides when the first layout may capture its canvas.
 *
 * The capture happens once, so it waits for the saved appearance to reach the root's
 * computed style (a stale or absent first-paint cache applies another density first), and
 * then for the surface to hold one size for `stableFrames` frames: the surface resizes some
 * frames after the root does. It never waits past `maxFrames`.
 */
export type LayoutGate = {
	/** Call once per animation frame; true when the capture may happen. */
	step(input: { appearanceApplied: boolean; size: string }): boolean;
};

export function createLayoutGate(options?: {
	maxFrames?: number;
	stableFrames?: number;
}): LayoutGate {
	const maxFrames = options?.maxFrames ?? 120;
	const stableFrames = options?.stableFrames ?? 20;
	let frames = 0;
	let held = 0;
	let lastSize: string | undefined;
	return {
		step({ appearanceApplied, size }) {
			frames += 1;
			if (!appearanceApplied || size !== lastSize) held = 0;
			else held += 1;
			lastSize = appearanceApplied ? size : undefined;
			return held >= stableFrames || frames >= maxFrames;
		}
	};
}
