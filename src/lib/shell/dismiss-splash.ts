/** The least time the start-up screen stays up, measured from navigation start. */
const MINIMUM_SPLASH_MS = 1000;

declare global {
	interface Window {
		/** Set by the e2e fixtures: the start-up screen is removed at once. */
		wobbleSkipSplash?: boolean;
	}
}

/** How long the start-up screen still has to stay after `elapsedMs` since navigation
 *  start. Never negative: a late mount waits no further. */
export function splashRemainingWait(elapsedMs: number, minimumMs = MINIMUM_SPLASH_MS): number {
	return Math.max(0, minimumMs - elapsedMs);
}

/** Fades the start-up screen (src/app.html) out and removes it. The content goes
 *  first and the ground after, 250ms in all — keep in step with the transitions there.
 *  The fade waits until the screen has been up for at least the minimum. */
export function dismissSplash(): void {
	const splash = document.getElementById('splash');
	if (!splash) return;
	if (window.wobbleSkipSplash) {
		splash.remove();
		return;
	}
	const wait = splashRemainingWait(performance.now());
	setTimeout(() => {
		splash.dataset.leaving = '';
		setTimeout(() => splash.remove(), 260);
	}, wait);
}
