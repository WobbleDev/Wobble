/** One recorded API response, keyed by the request that produced it. */
export type ApiRecording = {
	method: string;
	path: string;
	query?: string;
	status: number;
	body: unknown;
};

const bodylessStatuses = new Set([204, 205, 304]);

/**
 * A pure matcher over recorded responses. A request matches on method, pathname and the exact
 * query string. The n-th request for a key gets the n-th recorded response for it; once those
 * run out the last one repeats (polls and refetches). A miss throws, so a test never passes on
 * a guess.
 */
export function createReplay(
	recordings: readonly ApiRecording[]
): (path: string, init: RequestInit) => Response {
	const byKey = new Map<string, ApiRecording[]>();
	for (const recording of recordings) {
		const key = replayKey(recording.method, recording.path, recording.query ?? '');
		byKey.set(key, [...(byKey.get(key) ?? []), recording]);
	}
	const used = new Map<string, number>();

	return (path, init) => {
		const [barePath, query = ''] = path.split('?');
		const method = (init.method ?? 'GET').toUpperCase();
		const key = replayKey(method, barePath, query);
		const candidates = byKey.get(key);
		if (candidates === undefined) throw new Error(`No API recording for ${method} ${path}`);
		const ordinal = used.get(key) ?? 0;
		used.set(key, ordinal + 1);
		const recording = candidates[Math.min(ordinal, candidates.length - 1)];

		return new Response(
			bodylessStatuses.has(recording.status) ? null : JSON.stringify(recording.body),
			{
				status: recording.status,
				headers: { 'content-type': 'application/json' }
			}
		);
	};
}

function replayKey(method: string, path: string, query: string): string {
	return `${method.toUpperCase()} ${path}?${query}`;
}

/** One call a spec made through the `request` fixture, with what the server answered. */
export type SeedRecording = {
	method: string;
	/** Path plus query, as called. */
	path: string;
	requestBody?: unknown;
	status: number;
	body: unknown;
};

/** The contents of one recording file: the page's calls, plus the spec's own seeding calls. */
export type RecordingFile = {
	pages: ApiRecording[];
	seed?: SeedRecording[];
	worksite?: { id: string; name: string };
};

/** Reads a recording file in either shape: a bare array of page entries, or the object form. */
export function parseRecordingFile(json: unknown): RecordingFile {
	return Array.isArray(json) ? { pages: json as ApiRecording[] } : (json as RecordingFile);
}

/**
 * Answers the n-th call to a method and pathname from the n-th recorded entry for it, so a
 * repeated seeding call gets the response it got when recorded. A call with no entry throws.
 */
export function createSeedReplay(
	seed: readonly SeedRecording[]
): (method: string, path: string) => SeedRecording {
	const byKey = new Map<string, SeedRecording[]>();
	for (const entry of seed) {
		const key = seedKey(entry.method, entry.path);
		byKey.set(key, [...(byKey.get(key) ?? []), entry]);
	}
	const used = new Map<string, number>();

	return (method, path) => {
		const key = seedKey(method, path);
		const ordinal = used.get(key) ?? 0;
		const entry = byKey.get(key)?.[ordinal];
		if (entry === undefined) {
			throw new Error(`No seed recording for ${method.toUpperCase()} ${path.split('?')[0]}`);
		}
		used.set(key, ordinal + 1);
		return entry;
	};
}

function seedKey(method: string, path: string): string {
	return `${method.toUpperCase()} ${path.split('?')[0]}`;
}
