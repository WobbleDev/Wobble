// @module-tag mapping
import { describe, expect, it } from 'vitest';
import { boundsOf, frameWithNames, zoomStep, zoomSteps, type Rect } from './map-name-framing.ts';

const canvas = { width: 800, height: 600, padding: 28 };
const zoomFor = (frame: Rect) =>
	Math.min(
		1.2,
		(canvas.width - canvas.padding * 2) / frame.width,
		(canvas.height - canvas.padding * 2) / frame.height
	);

/** A dot at the right edge with an 80px name standing to its right. */
const edgeName = (zoom: number): Rect[] => [
	{ x: 660, y: 290, width: 80 / zoom, height: 14 / zoom }
];

describe('frameWithNames', () => {
	const dots: Rect = { x: -20, y: -20, width: 700, height: 400 };

	it('grows the frame so a name at the edge is inside the padded canvas', () => {
		const { frame, zoom } = frameWithNames({ dots, namesAt: edgeName, zoomFor });
		expect(zoom).toBeLessThan(zoomFor(dots)!);
		const nameRightPx = (edgeName(zoom!)[0].x + edgeName(zoom!)[0].width) * zoom!;
		const frameRightPx = (frame.x + frame.width) * zoom!;
		expect(nameRightPx).toBeLessThanOrEqual(frameRightPx + 0.5);
	});

	it('leaves the dots frame alone when every name is already inside it', () => {
		const inside = () => [{ x: 100, y: 100, width: 80, height: 14 }];
		const result = frameWithNames({ dots, namesAt: inside, zoomFor });
		expect(result.frame).toEqual(dots);
		expect(result.zoom).toBe(zoomFor(dots));
	});

	it('steps down only as far as the names need, within its step cap', () => {
		let asked = 0;
		const result = frameWithNames({
			dots,
			zoomFor,
			namesAt: (zoom) => {
				asked += 1;
				return edgeName(zoom);
			}
		});
		expect(asked).toBeLessThanOrEqual((zoomSteps + 1) * 4);
		// The step above it did not hold the names: no smaller map than necessary.
		const above = result.zoom! / zoomStep;
		const held = (zoom: number) =>
			zoomFor(
				edgeName(zoom).reduce(
					(all, box) => ({
						x: Math.min(all.x, box.x),
						y: Math.min(all.y, box.y),
						width: Math.max(all.x + all.width, box.x + box.width) - Math.min(all.x, box.x),
						height: Math.max(all.y + all.height, box.y + box.height) - Math.min(all.y, box.y)
					}),
					dots
				)
			)! >= zoom;
		expect(held(result.zoom!)).toBe(true);
		expect(held(above)).toBe(false);
	});

	it('is bounded when no zoom can hold the names', () => {
		let asked = 0;
		const result = frameWithNames({
			dots,
			zoomFor,
			namesAt: (zoom) => {
				asked += 1;
				return [{ x: 660, y: 290, width: 5000 / zoom, height: 14 / zoom }];
			}
		});
		expect(asked).toBe((zoomSteps + 1) * 4);
		expect(result.frame.width).toBeGreaterThanOrEqual(dots.width);
	});

	it('returns the dots frame when the camera cannot frame yet', () => {
		const result = frameWithNames({ dots, namesAt: edgeName, zoomFor: () => undefined });
		expect(result).toEqual({ frame: dots, zoom: undefined });
	});
});

describe('boundsOf', () => {
	it('holds every box, and is nothing for none', () => {
		expect(boundsOf([])).toBeUndefined();
		expect(
			boundsOf([
				{ left: 0, top: 0, right: 10, bottom: 5 },
				{ left: -4, top: 2, right: 3, bottom: 9 }
			])
		).toEqual({ x: -4, y: 0, width: 14, height: 9 });
	});
});
