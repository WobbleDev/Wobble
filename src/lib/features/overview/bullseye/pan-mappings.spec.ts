/**
 * The zoom arithmetic, which survives the move from a pointer-driven pan to a
 * drag, and the two functions the drag is built on: how far it may travel, and
 * how a scale change keeps the point under the pointer where it is.
 */
import { describe, expect, it } from 'vitest';
import {
	anchorPan,
	clampZoom,
	MIN_VISIBLE_SHARE,
	panBounds,
	type PanFrame,
	ZOOM_MAX,
	ZOOM_MIN,
	zoomAfterKey,
	zoomAfterWheel
} from './pan-mappings.ts';

describe('clampZoom', () => {
	it('keeps a scale already inside the range', () => {
		expect(clampZoom(ZOOM_MIN)).toBe(ZOOM_MIN);
		expect(clampZoom(1)).toBe(1);
		expect(clampZoom(ZOOM_MAX)).toBe(ZOOM_MAX);
	});

	it('pulls a scale outside the range back to the limit', () => {
		expect(clampZoom(0.1)).toBe(ZOOM_MIN);
		expect(clampZoom(9)).toBe(ZOOM_MAX);
	});

	it('falls back to the default for anything that is not a finite number', () => {
		expect(clampZoom(Number.NaN)).toBe(1);
		expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
		expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(1);
	});
});

describe('zoomAfterWheel', () => {
	it('magnifies on a wheel turned away and shrinks on one turned back', () => {
		expect(zoomAfterWheel(1, -100, 0)).toBeGreaterThan(1);
		expect(zoomAfterWheel(1, 100, 0)).toBeLessThan(1);
	});

	it('moves the scale further the bigger the delta', () => {
		expect(zoomAfterWheel(1, -100, 0)).toBeGreaterThan(zoomAfterWheel(1, -10, 0));
	});

	it('reaches the limit however hard the wheel turns', () => {
		expect(zoomAfterWheel(1, -10_000, 0)).toBe(ZOOM_MAX);
		expect(zoomAfterWheel(1, 10_000, 0)).toBe(ZOOM_MIN);
	});

	it('reads a line delta and a page delta as the pixels they stand for', () => {
		expect(zoomAfterWheel(1, -3, 1)).toBeGreaterThan(zoomAfterWheel(1, -3, 0));
		expect(zoomAfterWheel(1, -1, 2)).toBeGreaterThan(zoomAfterWheel(1, -1, 1));
	});

	it('never returns a scale outside the range', () => {
		for (const zoom of [ZOOM_MIN, 0.7, 1, 1.4, ZOOM_MAX]) {
			for (const delta of [-10_000, -1, 0, 1, 10_000]) {
				const next = zoomAfterWheel(zoom, delta, 0);
				expect(next).toBeGreaterThanOrEqual(ZOOM_MIN);
				expect(next).toBeLessThanOrEqual(ZOOM_MAX);
			}
		}
	});

	it('falls back to the default for a delta that is not a finite number', () => {
		expect(zoomAfterWheel(1.5, Number.NaN, 0)).toBe(1);
	});
});

describe('panBounds', () => {
	/** The floor's frame: 1024 wide and 900 tall, the column ending at 376, the chart resting at 894 by 470. */
	const frame: PanFrame = {
		centre: { x: 894, y: 470 },
		size: 1024,
		frame: { width: 1024, height: 900 },
		columnRight: 376
	};
	/** A share of the chart, in px, on the axis the share is measured against. */
	const visible = frame.size * MIN_VISIBLE_SHARE;

	it('holds a quarter of the chart clear of the column at the left limit', () => {
		const bounds = panBounds(frame);
		const rightEdge = frame.centre.x + frame.size / 2 + bounds.min.x;
		expect(rightEdge).toBeCloseTo(frame.columnRight + visible, 6);
	});

	it('holds a quarter of the chart inside the frame at the right limit', () => {
		const bounds = panBounds(frame);
		const leftEdge = frame.centre.x - frame.size / 2 + bounds.max.x;
		expect(leftEdge).toBeCloseTo(frame.frame.width - visible, 6);
	});

	it('holds a quarter of the chart inside the frame at the top and the bottom', () => {
		const bounds = panBounds(frame);
		const bottomEdge = frame.centre.y + frame.size / 2 + bounds.min.y;
		const topEdge = frame.centre.y - frame.size / 2 + bounds.max.y;
		expect(bottomEdge).toBeCloseTo(visible, 6);
		expect(topEdge).toBeCloseTo(frame.frame.height - visible, 6);
	});

	it('lets the chart rest inside its own bounds', () => {
		const bounds = panBounds(frame);
		expect(bounds.min.x).toBeLessThanOrEqual(0);
		expect(bounds.max.x).toBeGreaterThanOrEqual(0);
		expect(bounds.min.y).toBeLessThanOrEqual(0);
		expect(bounds.max.y).toBeGreaterThanOrEqual(0);
	});

	it('scales the share it holds with the chart', () => {
		const doubled = panBounds({ ...frame, size: frame.size * 2 });
		const rightEdge = frame.centre.x + frame.size + doubled.min.x;
		expect(rightEdge).toBeCloseTo(frame.columnRight + visible * 2, 6);
	});

	it('collapses an axis whose two limits have crossed to its midpoint', () => {
		// A frame the leading column's own edge reaches past: no quarter of the chart
		// can stay right of a column that is off the frame, so that axis holds its
		// middle rather than leaving the chart with no legal offset at all. The
		// vertical pair cannot cross, since the frame's own height is one of its limits.
		const cramped = panBounds({
			centre: { x: 894, y: 200 },
			size: 400,
			frame: { width: 400, height: 100 },
			columnRight: 900
		});
		expect(cramped.min.x).toBeCloseTo(cramped.max.x, 6);
		expect(cramped.min.y).toBeLessThanOrEqual(cramped.max.y);
	});
});

describe('anchorPan', () => {
	it('is the identity when the scale does not change', () => {
		expect(anchorPan({ x: 30, y: -20 }, { x: 100, y: 50 }, 1)).toEqual({ x: 30, y: -20 });
	});

	it('leaves the pan alone when the pointer is at the chart centre', () => {
		expect(anchorPan({ x: 40, y: 12 }, { x: 40, y: 12 }, 2)).toEqual({ x: 40, y: 12 });
	});

	it('keeps the point under the pointer in place, magnifying and shrinking', () => {
		for (const ratio of [2, 1.5, 0.5, 0.75]) {
			const pan = { x: -60, y: 24 };
			const offset = { x: 140, y: -90 };
			const next = anchorPan(pan, offset, ratio);
			// The chart's point under the pointer sits `offset - pan` from the centre
			// before the change; at the new scale it must keep its screen offset.
			expect(next.x + (offset.x - pan.x) * ratio).toBeCloseTo(offset.x, 6);
			expect(next.y + (offset.y - pan.y) * ratio).toBeCloseTo(offset.y, 6);
		}
	});

	it('composes, so two steps land where one of their product does', () => {
		const pan = { x: 10, y: -30 };
		const offset = { x: 100, y: 60 };
		const stepped = anchorPan(anchorPan(pan, offset, 1.5), offset, 2);
		const once = anchorPan(pan, offset, 1.5 * 2);
		expect(stepped.x).toBeCloseTo(once.x, 6);
		expect(stepped.y).toBeCloseTo(once.y, 6);
	});
});
describe('zoomAfterKey', () => {
	it('magnifies on + and =', () => {
		expect(zoomAfterKey(1, '+')).toBeGreaterThan(1);
		expect(zoomAfterKey(1, '=')).toBe(zoomAfterKey(1, '+'));
	});

	it('shrinks on - and the Unicode minus', () => {
		expect(zoomAfterKey(1, '-')).toBeLessThan(1);
		expect(zoomAfterKey(1, '−')).toBe(zoomAfterKey(1, '-'));
	});

	it('leaves any other key alone', () => {
		expect(zoomAfterKey(1, 'a')).toBe(1);
		expect(zoomAfterKey(1, 'ArrowUp')).toBe(1);
	});

	it('stops at the maximum however many times it magnifies', () => {
		let zoom = 1;
		for (let press = 0; press < 20; press += 1) zoom = zoomAfterKey(zoom, '+');
		expect(zoom).toBe(ZOOM_MAX);
	});

	it('stops at the minimum however many times it shrinks', () => {
		let zoom = 1;
		for (let press = 0; press < 20; press += 1) zoom = zoomAfterKey(zoom, '-');
		expect(zoom).toBe(ZOOM_MIN);
	});

	it('falls back inside the range for a non-finite input', () => {
		const next = zoomAfterKey(Number.NaN, '+');
		expect(next).toBeGreaterThanOrEqual(ZOOM_MIN);
		expect(next).toBeLessThanOrEqual(ZOOM_MAX);
	});
});
