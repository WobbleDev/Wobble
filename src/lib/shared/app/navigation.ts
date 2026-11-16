import type { ResolvedPathname } from '$app/types';
import { replaceState } from '$app/navigation';

/**
 * Appends query params to a path that `resolve()` has already produced.
 * The return type is `ResolvedPathname`, so `svelte/no-navigation-without-resolve`
 * accepts it in `href` and `goto()`. Keys and values are percent-encoded with
 * `encodeURIComponent`, which keeps the URL byte-identical to hand-built strings.
 */
export function withQuery(
	path: ResolvedPathname,
	params: Record<string, string>
): ResolvedPathname {
	const query = Object.entries(params)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join('&');
	return (query ? `${path}?${query}` : path) as ResolvedPathname;
}

/**
 * Appends a ready-made search string to a path that `resolve()` has produced. The
 * filters already know how to encode repeated keys, so a drilldown hands the whole
 * `URLSearchParams` over rather than flattening it into a record.
 */
export function withSearch(path: ResolvedPathname, params: URLSearchParams): ResolvedPathname {
	const query = params.toString();
	return (query ? `${path}?${query}` : path) as ResolvedPathname;
}

/**
 * Rewrites the current address in place: `edit` changes a copy of its search params
 * and the result replaces the history entry, so filters and view state stay
 * reloadable without filling Back. Params the edit leaves alone (the selected
 * Worker, for one) are kept. Return `false` from `edit` to leave the address as it
 * is. Returns whether the address was replaced.
 */
export function replaceCurrentUrl(
	edit: (params: URLSearchParams) => boolean | void,
	state: App.PageState = {}
): boolean {
	const url = new URL(window.location.href);
	if (edit(url.searchParams) === false) return false;
	// `url` is the current address, so it already carries any base path.
	// eslint-disable-next-line svelte/no-navigation-without-resolve -- replaceState on the current URL; resolve() takes a route, not a URL.
	replaceState(url, state);
	return true;
}
