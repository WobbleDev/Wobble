import { describe, expect, it } from 'vitest';
import { defaultAppSettings } from '#lib/shared/app-settings.ts';
import { applyAppearanceAttributes } from './appearance-attributes.ts';

const rootWith = (dataset: Record<string, string> = {}) => ({ dataset: { ...dataset } });

describe('applying the appearance attributes', () => {
	it('writes the Theme and Density as the root data-theme and data-density values', () => {
		for (const theme of ['system', 'light', 'dark'] as const) {
			const root = rootWith();
			applyAppearanceAttributes({ ...defaultAppSettings, theme }, root);
			expect(root.dataset.theme).toBe(theme);
		}

		for (const density of ['compact', 'standard', 'comfortable'] as const) {
			const root = rootWith();
			applyAppearanceAttributes({ ...defaultAppSettings, density }, root);
			expect(root.dataset.density).toBe(density);
		}
	});

	it('writes the Reduce motion preference, including system', () => {
		for (const reduceMotion of ['system', 'reduce', 'full'] as const) {
			const root = rootWith();
			applyAppearanceAttributes({ ...defaultAppSettings, reduceMotion }, root);
			expect(root.dataset.motion).toBe(reduceMotion);
		}
	});

	it('writes the Text size as the root data-text-size value', () => {
		for (const textSize of ['100', '110', '125', '150'] as const) {
			const root = rootWith();
			applyAppearanceAttributes({ ...defaultAppSettings, textSize }, root);
			expect(root.dataset.textSize).toBe(textSize);
		}
	});

	it('adds data-contrast only while Increase contrast is on, and removes it when off', () => {
		const on = rootWith();
		applyAppearanceAttributes({ ...defaultAppSettings, increaseContrast: true }, on);
		expect(on.dataset.contrast).toBe('on');

		const off = rootWith({ contrast: 'on' });
		applyAppearanceAttributes(defaultAppSettings, off);
		expect(off.dataset).not.toHaveProperty('contrast');
	});

	it('adds data-assessment-palette only while Color-blind colors are on, and removes it when off', () => {
		const on = rootWith();
		applyAppearanceAttributes({ ...defaultAppSettings, colorBlindAssessments: true }, on);
		expect(on.dataset.assessmentPalette).toBe('colorblind');

		const off = rootWith({ assessmentPalette: 'colorblind' });
		applyAppearanceAttributes(defaultAppSettings, off);
		expect(off.dataset).not.toHaveProperty('assessmentPalette');
	});
});
