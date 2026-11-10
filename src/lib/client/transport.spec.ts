import { afterEach, describe, expect, it, vi } from 'vitest';
import { initApiTransport, isTauriTransport, sendApiRequest } from './transport.ts';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

afterEach(() => {
	initApiTransport('http');
	vi.unstubAllGlobals();
	invoke.mockReset();
});

describe('sendApiRequest', () => {
	it('uses fetch on the http transport', async () => {
		const response = new Response('{}', { status: 200 });
		const fetchMock = vi.fn().mockResolvedValue(response);
		vi.stubGlobal('fetch', fetchMock);

		await expect(sendApiRequest('/api/settings', { method: 'GET' })).resolves.toBe(response);
		expect(fetchMock).toHaveBeenCalledWith('/api/settings', { method: 'GET' });
	});

	it('invokes api_request on the tauri transport and synthesises the reply', async () => {
		initApiTransport('tauri');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		invoke.mockResolvedValue({
			status: 201,
			headers: [['content-type', 'application/json']],
			body: { worker: { id: 'w1' } }
		});

		const response = await sendApiRequest('/api/workers?scope=roster', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-wobble-worksite': 'w1' },
			body: '{"name":"Rosalind Franklin"}'
		});

		expect(invoke).toHaveBeenCalledWith('api_request', {
			method: 'POST',
			path: '/api/workers',
			query: 'scope=roster',
			headers: [
				['content-type', 'application/json'],
				['x-wobble-worksite', 'w1']
			],
			body: '{"name":"Rosalind Franklin"}'
		});
		expect(response.status).toBe(201);
		expect(response.headers.get('content-type')).toBe('application/json');
		await expect(response.json()).resolves.toEqual({ worker: { id: 'w1' } });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('defaults the method to GET and sends null for an absent body', async () => {
		initApiTransport('tauri');
		invoke.mockResolvedValue({ status: 200, headers: [], body: { settings: {} } });

		// The dataset load passes `{ cache: 'no-store' }` and nothing else.
		const response = await sendApiRequest('/api/dataset', { cache: 'no-store' });

		expect(invoke).toHaveBeenCalledWith('api_request', {
			method: 'GET',
			path: '/api/dataset',
			query: '',
			headers: [],
			body: null
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ settings: {} });
	});
});

describe('initApiTransport', () => {
	it('keeps the http transport outside a Tauri webview', async () => {
		const response = new Response('{}', { status: 200 });
		const fetchMock = vi.fn().mockResolvedValue(response);
		vi.stubGlobal('fetch', fetchMock);

		initApiTransport();

		expect(isTauriTransport()).toBe(false);
		await expect(sendApiRequest('/api/dataset', {})).resolves.toBe(response);
		expect(fetchMock).toHaveBeenCalledWith('/api/dataset', {});
		expect(invoke).not.toHaveBeenCalled();
	});

	it('switches to the tauri transport inside a Tauri webview', async () => {
		vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
		invoke.mockResolvedValue({ status: 200, headers: [], body: {} });

		initApiTransport();
		expect(isTauriTransport()).toBe(true);
		await sendApiRequest('/api/dataset', {});

		expect(invoke).toHaveBeenCalledWith('api_request', {
			method: 'GET',
			path: '/api/dataset',
			query: '',
			headers: [],
			body: null
		});
	});
});

describe('replay transport', () => {
	it('answers from recordings without calling fetch or invoke', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		initApiTransport('replay', [
			{ method: 'GET', path: '/api/settings', query: 'a=1', status: 200, body: { ok: true } }
		]);

		const response = await sendApiRequest('/api/settings?a=1', { method: 'GET' });
		expect(await response.json()).toEqual({ ok: true });
		await expect(sendApiRequest('/api/settings', { method: 'GET' })).rejects.toThrow(
			'No API recording for GET /api/settings'
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(invoke).not.toHaveBeenCalled();
	});
});
