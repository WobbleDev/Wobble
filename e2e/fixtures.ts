import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { createReplay, createSeedReplay } from '../src/lib/client/replay.ts';
import type { ApiRecording, SeedRecording } from '../src/lib/client/replay.ts';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { readRecordings, recordingPath, writeRecordings } from './replay-recordings.ts';
import { activateWorksite, activeWorksiteHeaderName, followActiveWorksite } from './api.ts';

/** Known credential for owned, disposable encrypted test databases only. */
export const TEST_PASSPHRASE = 'Wobble isolated fixture passphrase';

/** The `ui` suite answers every API call from a recording, so nothing seeds or boots a server. */
export const isReplay = process.env.WOBBLE_E2E_SUITE === 'ui';
const isRecording = process.env.WOBBLE_E2E_RECORD === '1';

/** An any-shape placeholder: every property, call and string conversion yields another placeholder. */
function placeholder(): unknown {
	const target = function () {};
	return new Proxy(target, {
		get: (_, key) =>
			key === Symbol.toPrimitive ? () => 'replay' : key === 'then' ? undefined : placeholder(),
		apply: () => placeholder()
	});
}

/**
 * Stands in for the `request` fixture under replay. With recorded `seed` calls each one is
 * answered from its recorded entry (a call with none throws); without, every call succeeds with
 * placeholders and sends nothing.
 */
function replayRequest(seed?: SeedRecording[]): APIRequestContext {
	const replaySeed = seed === undefined ? undefined : createSeedReplay(seed);
	const respond = (method: string, status: number) => async (url: string) => {
		const recorded = replaySeed?.(method, url);
		return {
			ok: () => (recorded?.status ?? status) < 400,
			status: () => recorded?.status ?? status,
			statusText: () => 'replay',
			text: async () => (recorded ? JSON.stringify(recorded.body) : '{}'),
			json: async () => (recorded ? recorded.body : placeholder()),
			headers: () => ({})
		};
	};
	return {
		get: respond('GET', 200),
		post: respond('POST', 201),
		put: respond('PUT', 200),
		patch: respond('PATCH', 200),
		delete: respond('DELETE', 200),
		fetch: (url: string, options?: { method?: string }) =>
			respond((options?.method ?? 'GET').toUpperCase(), 200)(url),
		head: respond('HEAD', 200),
		dispose: async () => undefined
	} as unknown as APIRequestContext;
}

const idCalls = new Map<string, number>();

/**
 * A fresh id for the running test. When recording or replaying it is derived from the spec file,
 * test title and a per-test call counter, so a replayed run puts the same ids on the wire as the
 * recording. On regular runs it is random, so repeat-each and parallel workers never collide
 * (ids are primary keys across all Worksites). Call it in the same order every run.
 */
export function testId(prefix?: string): string {
	let id = randomUUID();
	if (isRecording || isReplay) {
		const info = base.info();
		const n = (idCalls.get(info.testId) ?? 0) + 1;
		idCalls.set(info.testId, n);
		const h = createHash('sha1')
			.update(
				`${relative(info.config.rootDir, info.file).split(sep).join('/')}\n${info.title}\n${n}`
			)
			.digest('hex');
		id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
	}
	return prefix ? `${prefix}-${id}` : id;
}

type SeedCapture = { seed: SeedRecording[]; worksite?: TestWorksite };
const captures = new Map<string, SeedCapture>();

/**
 * Read-only POSTs the page makes: the recorder saves them with the GETs, and replay answers
 * the n-th call from the n-th entry (the last repeats), like any other recorded request.
 */
const readOnlyPosts = new Set(['/api/configuration/abbreviations']);

const recordedMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch'] as const;

/** Wraps a real request context so every call is appended, in call order, to `seed`. */
function recordingRequest(real: APIRequestContext, seed: SeedRecording[]): APIRequestContext {
	return new Proxy(real, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (!recordedMethods.includes(key as (typeof recordedMethods)[number])) {
				return typeof value === 'function' ? value.bind(target) : value;
			}
			return async (url: string, options?: { data?: unknown; method?: string }) => {
				const slot = seed.length;
				seed.push(undefined as unknown as SeedRecording);
				const response = await (value as (...args: unknown[]) => Promise<APIResponse>).call(
					target,
					url,
					options
				);
				const body = await response.json().catch(() => null);
				const method = key === 'fetch' ? (options?.method ?? 'GET') : String(key);
				seed[slot] = {
					method: method.toUpperCase(),
					path: url,
					...(options?.data === undefined ? {} : { requestBody: options.data }),
					status: response.status(),
					body
				};
				return response;
			};
		}
	});
}

type TestWorksite = { id: string; name: string };

export const test = base.extend<{
	activeWorksite: TestWorksite;
	apiReplay: void;
	apiRecorder: void;
	splash: 'skip' | 'hold';
}>({
	// Specs that assert what the app looks like once it has settled after start-up keep the
	// hold, because the start-up screen covers that settling for users too.
	splash: ['skip', { option: true }],

	// The splash's minimum hold is ~1.5 s of every test.
	context: async ({ context, splash }, use) => {
		if (splash === 'skip') {
			await context.addInitScript(() => {
				window.wobbleSkipSplash = true;
			});
		}
		await use(context);
	},

	// Every API call a spec makes names the Active Worksite, so the suite no longer
	// depends on a cookie the server set.
	request: async ({ playwright, baseURL }, use, testInfo) => {
		if (isReplay) {
			// Nothing to seed: the page's calls come from the recording, so seeding calls through
			// `request` are acknowledged without reaching a server. Values read back from a seed
			// response are placeholders; a spec that asserts on them cannot run on replay.
			const recorded = readRecordings(recordingPath(testInfo.file, testInfo.title));
			await use(replayRequest(recorded.seed));
			return;
		}
		const bootstrap = await playwright.request.newContext({ baseURL });
		const boot = await bootstrap.get('/api/boot-status');
		expect(boot.ok()).toBeTruthy();
		const status = await boot.json();
		if (status.state === 'open') expect(status.encrypted).toBe(true);
		if (status.state !== 'open') {
			expect(status.state).toBe('locked');
			expect(status.legacyPlaintext).toBe(false);
			expect(status.markerPending).toBe(false);
			const unlocked = await bootstrap.post(
				status.firstRun ? '/api/boot-create' : '/api/boot-unlock',
				{
					data: {
						passphrase: TEST_PASSPHRASE,
						...(status.firstRun ? { confirm: TEST_PASSPHRASE } : {})
					}
				}
			);
			if (unlocked.status() === 409) {
				// Another worker created or unlocked the store first: it must be open now.
				const after = await (await bootstrap.get('/api/boot-status')).json();
				expect(after.state).toBe('open');
				expect(after.encrypted).toBe(true);
			} else {
				expect(unlocked.status()).toBe(200);
				expect((await unlocked.json()).encrypted).toBe(true);
			}
		}
		const created = await bootstrap.post('/api/worksite');
		expect(created.status()).toBe(201);
		const { worksite } = (await created.json()) as { worksite: TestWorksite };
		await bootstrap.dispose();

		const request = await playwright.request.newContext({
			baseURL,
			extraHTTPHeaders: { [activeWorksiteHeaderName]: worksite.id }
		});

		if (isRecording) {
			const capture: SeedCapture = { seed: [] };
			captures.set(testInfo.testId, capture);
			await use(recordingRequest(request, capture.seed));
		} else {
			await use(request);
		}
		await request.dispose();
	},

	activeWorksite: [
		async ({ context, request }, use, testInfo) => {
			if (isReplay) {
				const recorded = readRecordings(recordingPath(testInfo.file, testInfo.title));
				await use(recorded.worksite ?? { id: 'replay', name: 'replay' });
				return;
			}
			const selected = await request.get('/api/worksite');
			const { worksite } = (await selected.json()) as { worksite: TestWorksite };
			const capture = captures.get(testInfo.testId);
			if (capture) capture.worksite = worksite;
			await activateWorksite(context, worksite.id);
			await followActiveWorksite(context);
			await use(worksite);
		},
		{ auto: true }
	],

	// `ui` suite: answers `/api/` from this test's recording; a miss is a 599 and fails the test.
	apiReplay: [
		async ({ page }, use, testInfo) => {
			if (!isReplay) {
				await use();
				return;
			}
			const replay = createReplay(
				readRecordings(recordingPath(testInfo.file, testInfo.title)).pages
			);
			const misses = new Set<string>();
			await page.route('**/api/**', async (route) => {
				const request = route.request();
				const url = new URL(request.url());
				try {
					const response = replay(url.pathname + url.search, { method: request.method() });
					await route.fulfill({
						status: response.status,
						contentType: 'application/json',
						body: await response.text()
					});
				} catch (error) {
					misses.add(error instanceof Error ? error.message : String(error));
					await route.fulfill({ status: 599, body: '' });
				}
			});
			await use();
			expect([...misses], 'API requests with no recording').toEqual([]);
		},
		{ auto: true }
	],

	// With `WOBBLE_E2E_RECORD=1`, saves every `/api/` GET the page made, for the `ui` suite.
	apiRecorder: [
		async ({ page, request }, use, testInfo) => {
			// `request` is a dependency only: it must outlive this fixture's teardown.
			void request;
			if (!isRecording || isReplay) {
				await use();
				return;
			}
			const recordings: ApiRecording[] = [];
			const pending: Promise<void>[] = [];
			// Selection aid: WOBBLE_E2E_WRITES_LOG names a file that gets one line per page write.
			page.on('request', (request) => {
				const log = process.env.WOBBLE_E2E_WRITES_LOG;
				const url = new URL(request.url());
				if (!log || request.method() === 'GET' || !url.pathname.startsWith('/api/')) return;
				appendFileSync(
					log,
					JSON.stringify({
						file: testInfo.file,
						title: testInfo.title,
						write: `${request.method()} ${url.pathname}`
					}) + '\n'
				);
			});
			page.on('response', (response) => {
				const request = response.request();
				const url = new URL(response.url());
				const readOnly =
					request.method() === 'GET' ||
					(request.method() === 'POST' && readOnlyPosts.has(url.pathname));
				if (!readOnly || !url.pathname.startsWith('/api/')) return;
				// Reserve the slot now so entries stay in response order, not json() order.
				const slot = recordings.length;
				recordings.push(undefined as unknown as ApiRecording);
				pending.push(
					response
						.json()
						.then((body: unknown) => {
							recordings[slot] = {
								method: request.method(),
								path: url.pathname,
								...(url.search ? { query: url.search.slice(1) } : {}),
								status: response.status(),
								body
							};
						})
						.catch(() => undefined)
				);
			});
			await use();
			await Promise.all(pending);
			// The settings poll may not have fired before the test ended; replay always answers it.
			if (!recordings.some((entry) => entry?.path === '/api/settings')) {
				const settings = await page.request.get('/api/settings');
				recordings.push({
					method: 'GET',
					path: '/api/settings',
					status: settings.status(),
					body: await settings.json()
				});
			}
			const capture = captures.get(testInfo.testId);
			captures.delete(testInfo.testId);
			writeRecordings(recordingPath(testInfo.file, testInfo.title), {
				pages: recordings.filter((entry) => entry !== undefined),
				...(capture ? { seed: capture.seed, worksite: capture.worksite } : {})
			});
		},
		{ auto: true }
	]
});

/**
 * How many elements under main the user could scroll (auto/scroll overflow with
 * excess). A [data-scroll-region] is a panel's own inner scroller, the one
 * deliberate kind, so it is not counted: the surface itself must not scroll.
 */
export async function scrollableOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const main = document.querySelector('main');
		if (!main) return 0;
		let count = 0;
		for (const el of main.querySelectorAll('*')) {
			if (el.matches('[data-scroll-region]')) continue;
			const style = getComputedStyle(el);
			if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
				count += 1;
			}
			if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
				count += 1;
			}
		}
		return count;
	});
}

/**
 * Content that is hidden rather than shown: an element clipping overflow it
 * cannot fit. A no-scroll surface fits by scrolling a panel inside itself or
 * compacting, so this must stay empty there. Three kinds of clipping are
 * deliberate and skipped: the scroll region, whose clipping is the mechanism; the bullseye chart backdrop, which is
 * oversized on purpose and dragged to; and screen-reader-only text, whose whole
 * job is to leave the visual flow.
 */
export async function clippedContent(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const main = document.querySelector('main');
		if (!main) return [];
		const found: string[] = [];
		for (const el of main.querySelectorAll('*')) {
			if (el.closest('[data-scroll-region], [data-bullseye-base], .sr-only')) continue;
			const style = getComputedStyle(el);
			if (!/(hidden|clip)/.test(style.overflowY)) continue;
			if (el.scrollHeight <= el.clientHeight + 1) continue;
			const slot = el.getAttribute('data-slot') ?? '';
			const cls = typeof el.className === 'string' ? el.className.slice(0, 40) : '';
			found.push(
				`${el.tagName.toLowerCase()}[${slot}${cls}] ${el.clientHeight}/${el.scrollHeight}`
			);
		}
		return found;
	});
}

export { expect };
