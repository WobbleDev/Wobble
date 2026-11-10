import { vi } from 'vitest';

/** A JSON response carrying `body` at `status`. */
export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/** One call the scripted adapter observed: its method, path and decoded JSON body. */
export type ScriptedCall = {
	method: string;
	path: string;
	body: unknown;
};

/** The reply one scripted route returns; a missing status means 200 and a missing body `null`. */
export type ScriptedReply = {
	status?: number;
	body?: unknown;
};

/** The request handed to a scripted route: the decoded JSON body and the full URL. */
export type ScriptedRouteRequest = {
	body: unknown;
	url: URL;
};

function readBody(body: BodyInit | null | undefined): unknown {
	if (typeof body !== 'string') return body ?? undefined;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

/**
 * Installs a `fetch` stub keyed by `"METHOD /path"` and records every call's method,
 * path and body. A route may answer with a promise when a spec holds a reply open.
 * A request no route answers rejects with its method and path, so the gap is named.
 */
export function scriptFetch(
	routes: Record<string, (request: ScriptedRouteRequest) => ScriptedReply | Promise<ScriptedReply>>
): { calls: ScriptedCall[] } {
	const calls: ScriptedCall[] = [];

	const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(href, 'http://localhost');
		const method = (init.method ?? 'GET').toUpperCase();
		const body = readBody(init.body);
		calls.push({ method, path: url.pathname, body });

		const route = routes[`${method} ${url.pathname}`];
		if (!route) throw new Error(`No scripted response for ${method} ${url.pathname}`);
		const reply = await route({ body, url });
		return jsonResponse(reply.body ?? null, reply.status);
	});

	vi.stubGlobal('fetch', fetchStub);
	return { calls };
}

/** Installs a Map-backed `localStorage` stub and returns it. */
export function stubStorage(): Storage {
	const store = new Map<string, string>();
	const storage: Storage = {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key: string) => store.get(key) ?? null,
		key: (index: number) => [...store.keys()][index] ?? null,
		removeItem: (key: string) => void store.delete(key),
		setItem: (key: string, value: string) => void store.set(key, value)
	};
	vi.stubGlobal('localStorage', storage);
	return storage;
}
