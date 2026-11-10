/**
 * Reads the document root's attributes that the Overview's labels and text size
 * depend on. The observer is injected, so the watcher is specced with a literal
 * host and runs without a DOM.
 */

export interface RootObserverLike {
	observe(target: unknown, options: { attributes: true; attributeFilter: string[] }): void;
	disconnect(): void;
}

export interface RootMediaLike {
	readonly matches: boolean;
	addEventListener(type: 'change', listener: () => void): void;
	removeEventListener(type: 'change', listener: () => void): void;
}

export interface RootWatchHost {
	readonly root: unknown;
	createObserver(callback: () => void): RootObserverLike;
	/** The colour-scheme query, when the reading depends on it. */
	readonly media?: RootMediaLike;
}

/**
 * Runs `read` now, then again on every change to the watched attributes and on a
 * colour-scheme change. Returns the cleanup that removes both listeners.
 */
export function watchRootAttributes(
	host: RootWatchHost,
	attributes: readonly string[],
	read: () => void
): () => void {
	read();
	host.media?.addEventListener('change', read);
	const observer = host.createObserver(read);
	observer.observe(host.root, { attributes: true, attributeFilter: [...attributes] });
	return () => {
		host.media?.removeEventListener('change', read);
		observer.disconnect();
	};
}

/** Enlarged text outgrows the dashboard's floor budget at these root sizes. */
export function isEnlargedText(textSize: string | undefined): boolean {
	return textSize === '125' || textSize === '150';
}

/**
 * The theme and palette the labels read: a `system` theme follows the colour scheme,
 * and the colour-blind palette is named on the root.
 */
export function readRootTheme(
	theme: string | undefined,
	assessmentPalette: string | undefined,
	prefersDark: boolean
): { darkTheme: boolean; colorblindPalette: boolean } {
	const resolved = theme ?? 'system';
	return {
		darkTheme: resolved === 'dark' || (resolved === 'system' && prefersDark),
		colorblindPalette: assessmentPalette === 'colorblind'
	};
}
