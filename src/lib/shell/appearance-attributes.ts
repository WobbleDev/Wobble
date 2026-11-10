import type { AppSettings } from '#lib/shared/app-settings.ts';

/** The slice of the document root the appearance mapping writes to. */
export type AppearanceRoot = { dataset: Record<string, string | undefined> };

function setOptional(root: AppearanceRoot, key: string, value: string | undefined): void {
	if (value === undefined) delete root.dataset[key];
	else root.dataset[key] = value;
}

/**
 * Reconciles the document root's appearance attributes with the saved settings:
 * data-theme, data-density, data-motion, data-text-size, data-contrast and
 * data-assessment-palette. The first-paint script in src/app.html applies the same
 * mapping from the local cache before the app mounts; keep the two in step.
 */
export function applyAppearanceAttributes(settings: AppSettings, root: AppearanceRoot): void {
	root.dataset.theme = settings.theme;
	root.dataset.density = settings.density;
	root.dataset.motion = settings.reduceMotion;
	root.dataset.textSize = settings.textSize;
	setOptional(root, 'contrast', settings.increaseContrast ? 'on' : undefined);
	setOptional(root, 'assessmentPalette', settings.colorBlindAssessments ? 'colorblind' : undefined);
}
