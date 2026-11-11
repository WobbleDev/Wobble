// @module-tag mapping
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPanZoom, fitCamera } from './map-pan-zoom.svelte.ts';

afterEach(() => vi.unstubAllGlobals());

const view = {
	width: 800,
	height: 600,
	left: 10,
	top: 20,
	matrixE: 400,
	matrixF: 300,
	insets: { top: 40, bottom: 60, left: 0, right: 100 }
};

describe('fitCamera', () => {
	it('frames the box in the free area at the fitted zoom', () => {
		const box = { x: -250, y: -125, width: 500, height: 250 };
		const camera = fitCamera(box, view, 28, 4);
		expect(camera.zoom).toBeCloseTo(Math.min((800 - 56) / 500, (600 - 56 - 100) / 250));
		// The box centre lands on the middle of the free area.
		expect(400 + camera.panX + camera.zoom * 0).toBeCloseTo(10 + (800 - 100) / 2);
		expect(300 + camera.panY).toBeCloseTo(20 + (600 + 40 - 60) / 2);
	});

	it('zooms out past 40% when that is what fits the whole map', () => {
		const box = { x: 0, y: 0, width: 4000, height: 2000 };
		const camera = fitCamera(box, view, 28, 4);
		expect(camera.zoom).toBeCloseTo((800 - 56) / 4000);
		expect(camera.zoom).toBeLessThan(0.4);
	});

	it('honours the cap and a forced zoom', () => {
		const box = { x: 0, y: 0, width: 10, height: 10 };
		expect(fitCamera(box, view, 28, 1.2).zoom).toBe(1.2);
		expect(fitCamera(box, view, 0, 1, 1).zoom).toBe(1);
	});

	it('frames a line-shaped set at 1× in the free canvas', () => {
		class TestGraphicsElement {}
		vi.stubGlobal('SVGGraphicsElement', TestGraphicsElement);

		const panZoom = createPanZoom();
		const centeredLayer = Object.assign(new TestGraphicsElement(), {
			getScreenCTM: () => ({ e: 840, f: 525 })
		});
		const surface = {
			getBoundingClientRect: () => ({ width: 1152, height: 702, left: 264, top: 174 })
		};
		panZoom.layer = {
			parentElement: centeredLayer,
			ownerSVGElement: surface
		} as unknown as SVGGElement;
		panZoom.setInsets(60, 70);

		const bounds = { x: 997.918256286439, y: 631.8, width: 77.76348742712196, height: 0 };
		const camera = panZoom.targetFor(bounds, 0, 1, 1);

		expect(camera).toBeDefined();
		if (!camera) return;
		expect(camera.zoom).toBe(1);

		const centerX = 840 + camera.panX + (bounds.x + bounds.width / 2) * camera.zoom;
		const centerY = 525 + camera.panY + bounds.y * camera.zoom;
		expect(centerX).toBeCloseTo(840);
		expect(centerY).toBeCloseTo(520);
		// Each dot has a 4.4px radius at 1×; their shared center stays clear of
		// the 234px–806px free-canvas vertical range.
		expect(centerY - 4.4).toBeGreaterThanOrEqual(234);
		expect(centerY + 4.4).toBeLessThanOrEqual(806);
	});
});
