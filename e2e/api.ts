import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import type { DatasetReply } from '../src/lib/client/generated/DatasetReply.ts';
import { wireWorkerAttributes } from './answer-wire.ts';

/** The request header that names the Active Worksite (mirrors `#lib/shared/active-worksite-header.ts`). */
export const activeWorksiteHeaderName = 'x-wobble-worksite';

/** The webview-storage key the client remembers the Active Worksite under. */
export const activeWorksiteStorageKey = 'wobble.active-worksite-id';

type WorksiteResponse = { worksite: { id: string } | null };

/** Makes every request the context sends name this Worksite, and seeds the app's own memory. */
export async function activateWorksite(context: BrowserContext, id: string): Promise<void> {
	await context.setExtraHTTPHeaders({ [activeWorksiteHeaderName]: id });
	await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
		activeWorksiteStorageKey,
		id
	] as [string, string]);
}

/**
 * Keeps the context header in step with the Worksite the app itself switches to.
 *
 * Every request names its Worksite in a header the core reads, but the app can only
 * change its own requests, so the test browser follows the app's activate/create/
 * delete calls to resolve the same Worksite on the next request.
 */
export async function followActiveWorksite(context: BrowserContext): Promise<void> {
	await context.route('**/api/worksite/active', async (route) => {
		try {
			const body = route.request().postDataJSON() as { id?: unknown };
			if (typeof body?.id === 'string') {
				await context.setExtraHTTPHeaders({ [activeWorksiteHeaderName]: body.id });
			}
		} catch {
			// A non-JSON selection body is the handler's 400 to give; leave the header alone.
		}
		await route.continue();
	});

	await context.route('**/api/worksite', async (route) => {
		const method = route.request().method();
		if (method !== 'POST' && method !== 'DELETE') {
			await route.continue();
			return;
		}

		const response = await route.fetch();
		const body = (await response.json()) as WorksiteResponse;
		await context.setExtraHTTPHeaders(
			body.worksite ? { [activeWorksiteHeaderName]: body.worksite.id } : {}
		);
		await route.fulfill({ response });
	});
}

/** Reads the Worksite id the client stored, as the browser sees it. */
export function readStoredActiveWorksiteId(page: Page): Promise<string | null> {
	return page.evaluate((key) => localStorage.getItem(key), activeWorksiteStorageKey);
}

/**
 * The fields a seed may set on a Worker. Attribute values are text: `createWorker`
 * maps them to answer ids itself, so pass the text, not a wire payload.
 */
export type WorkerSeed = {
	name?: string;
	email?: string;
	assessment?: string;
	attributes?: Record<string, string | string[]>;
	agitations?: string[];
	notes?: { id: string; text: string; timestamp: string }[];
};

/**
 * The writable half of a Worker read back from the dataset: the id names the
 * record, so the Worker PUT rejects it. Spread the result into an update body
 * and override the fields being changed.
 */
export function workerUpdateFrom<T extends { id: string }>(worker: T): Omit<T, 'id'> {
	const body = { ...worker } as Record<string, unknown>;
	delete body.id;
	return body as Omit<T, 'id'>;
}

/**
 * Creates one Worker through the full-record endpoint, with every field defaulted.
 * Attribute text is mapped to answer ids; a blank Category stays blank.
 */
export async function createWorker(
	request: APIRequestContext,
	worker: WorkerSeed = {}
): Promise<void> {
	const created = await request.post('/api/workers', {
		data: {
			name: worker.name ?? 'A Worker',
			email: worker.email ?? '',
			phone: '',
			assessment: worker.assessment ?? 'Unassessed',
			attributes: wireWorkerAttributes(worker.attributes ?? {}),
			agitations: worker.agitations ?? [],
			languages: [],
			relationships: [],
			notes: worker.notes ?? []
		}
	});
	expect(created.status(), await created.text()).toBe(201);
}

/**
 * A Worker to create with attribute ids already resolved: pass the ids a definition
 * request returned, as the Configuration specs do. Unlike `createWorker`, this maps
 * nothing, so it is the right helper once the attributes are ids.
 */
export async function createWorkerWithIds(
	request: APIRequestContext,
	worker: {
		name: string;
		attributes?: Record<string, unknown>;
		email?: string;
		phone?: string;
		assessment?: string;
		agitations?: string[];
		languages?: string[];
		relationships?: string[];
		notes?: { id: string; text: string; timestamp: string }[];
	}
): Promise<string> {
	const response = await request.post('/api/workers', {
		data: {
			name: worker.name,
			email: worker.email ?? '',
			phone: worker.phone ?? '',
			assessment: worker.assessment ?? 'Unassessed',
			attributes: worker.attributes ?? {},
			agitations: worker.agitations ?? [],
			languages: worker.languages ?? [],
			relationships: worker.relationships ?? [],
			notes: worker.notes ?? []
		}
	});
	expect(response.status(), await response.text()).toBe(201);
	return ((await response.json()) as { worker: { id: string } }).worker.id;
}

/**
 * Records the writes the page sends, as `METHOD path` strings, ignoring reads and the
 * read-only Configuration preview.
 */
export function observeWrites(page: Page): string[] {
	const writes: string[] = [];
	page.on('request', (request) => {
		const method = request.method();
		const path = new URL(request.url()).pathname;
		if (
			method === 'GET' ||
			path === '/api/configuration/preview' ||
			path === '/api/configuration/abbreviations'
		)
			return;
		writes.push(`${method} ${path}`);
	});
	return writes;
}

/** Saves a Worker draft, failing on anything but the 200 the draft route returns. */
export async function saveDraft(
	request: APIRequestContext,
	id: string,
	draft: Record<string, unknown>
): Promise<void> {
	const response = await request.put('/api/worker-drafts/' + id, { data: draft });
	expect(response.status(), await response.text()).toBe(200);
}

/**
 * Reads the dataset without `worksites`, the installation-wide list of every Worksite,
 * so that comparisons stay stable while other tests create and delete their own Worksites.
 */
export async function worksiteDataset<T = Omit<DatasetReply, 'worksites'>>(
	request: APIRequestContext
): Promise<T> {
	const response = await request.get('/api/dataset');
	expect(response.ok(), await response.text()).toBeTruthy();
	const dataset = (await response.json()) as Partial<DatasetReply>;
	delete dataset.worksites;
	return dataset as T;
}

/** Reads the Worksite dataset as a typed view; see `worksiteDataset`. */
export async function readDataset<T = Omit<DatasetReply, 'worksites'>>(
	request: APIRequestContext
): Promise<T> {
	return worksiteDataset<T>(request);
}
