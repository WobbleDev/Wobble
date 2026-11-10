import type { Locator } from '@playwright/test';

/** Resolve CSS colors in Chromium and composite transparent ancestor surfaces. */
export async function paintedColors(locator: Locator) {
	return locator.evaluateAll((elements) => {
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext('2d', { alpha: false })!;
		const fill = (css: string) => {
			// Reject unsupported canvas parsing rather than silently reading its old black fill.
			context.fillStyle = '#ff00ff';
			context.fillStyle = css;
			const first = context.fillStyle;
			context.fillStyle = '#00ffff';
			context.fillStyle = css;
			if (context.fillStyle !== first) throw new Error(`Cannot resolve CSS color: ${css}`);
			context.fillRect(0, 0, 1, 1);
		};
		const rgb = () => {
			const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
			return `rgb(${r}, ${g}, ${b})`;
		};
		const base =
			getComputedStyle(document.documentElement).getPropertyValue('--page').trim() || '#ffffff';
		const paint = (element: Element) => {
			fill(base);
			const ancestors: Element[] = [];
			for (let current: Element | null = element; current; current = current.parentElement)
				ancestors.push(current);
			for (const ancestor of ancestors.reverse()) fill(getComputedStyle(ancestor).backgroundColor);
		};
		return elements.map((element) => {
			paint(element);
			const background = rgb();
			fill(getComputedStyle(element).color);
			const color = rgb();
			fill(base);
			fill(getComputedStyle(document.documentElement).getPropertyValue('--inset'));
			const neutral = rgb();
			return { background, color, neutral, text: element.textContent?.trim() ?? '' };
		});
	});
}
