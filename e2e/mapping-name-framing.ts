import type { Page } from '@playwright/test';

type Rect = { left: number; top: number; right: number; bottom: number };

export type NameReading = {
	scale: number;
	camera: string;
	layoutCanvas: string | null;
	usable: Rect;
	chrome: { id: string; box: Rect }[];
	names: { id: string; text: string; box: Rect }[];
};

/** The names standing on the map, in screen pixels, with the canvas they must fit inside. */
export async function readNames(page: Page): Promise<NameReading> {
	return page.evaluate(async () => {
		// A camera written this task can still read back stale from the screen matrix.
		await new Promise<void>((done) =>
			requestAnimationFrame(() => requestAnimationFrame(() => done()))
		);
		const surface = document.querySelector<HTMLElement>(
			'[data-testid="relationship-map-surface"]'
		)!;
		const layer = surface.querySelector<SVGGElement>('[data-testid="relationship-map-layer"]')!;
		const matrix = layer.getScreenCTM()!;
		const rectOf = (element: Element): Rect => {
			const { left, top, right, bottom } = element.getBoundingClientRect();
			return { left, top, right, bottom };
		};
		const canvas = rectOf(document.querySelector('[data-testid="relationship-map-canvas"]')!);
		const strip = document.querySelector('[data-testid="mapping-control-strip"]');
		const stripBox = strip ? rectOf(strip) : undefined;
		return {
			scale: matrix.a,
			camera: [matrix.a, matrix.e, matrix.f].map((value) => value.toFixed(3)).join(','),
			layoutCanvas: surface.getAttribute('data-layout-canvas'),
			// The strip floats over the top edge; below `lg` it is in flow and still above the map.
			usable: { ...canvas, top: Math.max(canvas.top, stripBox?.bottom ?? canvas.top) },
			chrome: ['mapping-bottom-bar', 'mapping-dot-key'].flatMap((testId) => {
				const element = document.querySelector(`[data-testid="${testId}"]`);
				return element && innerWidth >= 1024 ? [{ id: testId, box: rectOf(element) }] : [];
			}),
			names: [...surface.querySelectorAll<SVGTextElement>('text[data-node-label]')].map((text) => ({
				id: text.dataset.nodeLabel!,
				text: text.textContent?.trim() ?? '',
				box: rectOf(text)
			}))
		};
	});
}

/** Names not wholly inside the usable canvas, or standing under the floating chrome. */
export function clippedNames(reading: NameReading, tolerancePx = 1): string[] {
	const { usable } = reading;
	return reading.names.flatMap(({ text, box }) => {
		const outside =
			box.left < usable.left - tolerancePx ||
			box.right > usable.right + tolerancePx ||
			box.top < usable.top - tolerancePx ||
			box.bottom > usable.bottom + tolerancePx;
		const covered = reading.chrome.some(
			({ box: c }) =>
				box.left < c.right && box.right > c.left && box.top < c.bottom && box.bottom > c.top
		);
		return outside || covered ? [text] : [];
	});
}
