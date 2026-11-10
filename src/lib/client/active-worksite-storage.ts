/** The webview-storage key that remembers this browser's Active Worksite. */
const storageKey = 'wobble.active-worksite-id';

/** The id this browser last chose, or null when storage holds none or is unavailable. */
export function readStoredActiveWorksiteId(): string | null {
	try {
		return globalThis.localStorage?.getItem(storageKey) ?? null;
	} catch {
		return null;
	}
}

/** Remembers the chosen Active Worksite, or forgets it when given null. */
export function storeActiveWorksiteId(id: string | null): void {
	try {
		if (id === null) globalThis.localStorage?.removeItem(storageKey);
		else globalThis.localStorage?.setItem(storageKey, id);
	} catch {
		// Storage can be denied (private mode, SSR); a missing memory only means the
		// server falls back to the cookie until the next explicit choice.
	}
}
