import { expect, type APIRequest } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Own the PID, database and port; a lifecycle test never stops the suite's server. */
export async function ownedShim(requests: APIRequest, legacyFixture?: string) {
	const directory = await mkdtemp(join(tmpdir(), 'wobble-boot-'));
	const database = join(directory, 'owned.sqlite');
	if (legacyFixture) await copyFile(legacyFixture, database);
	// The port AND the request context are allocated per start: a restarted server
	// on the same port can inherit the browser's pooled keep-alive sockets, and one
	// wedged pooled connection stalls a single asset fetch past every timeout while
	// the server itself is healthy (ERR_CONNECTION_RESET on exactly one chunk, app
	// never hydrates). A fresh port per start keeps pooled sockets bound to a dead
	// server unreachable, so the browser always opens new connections.
	let port = 0;
	let url = '';
	let request = await requests.newContext();
	async function reserve() {
		const reservation = createServer();
		await new Promise<void>((done, reject) => {
			reservation.once('error', reject);
			reservation.listen(0, '127.0.0.1', done);
		});
		const address = reservation.address();
		if (!address || typeof address === 'string')
			throw new Error('No owned test port was allocated.');
		port = address.port;
		await new Promise<void>((done, reject) =>
			reservation.close((error) => (error ? reject(error) : done()))
		);
		url = 'http://127.0.0.1:' + port;
		await request.dispose();
		request = await requests.newContext({ baseURL: url });
	}
	await reserve();
	const binary =
		process.env.WOBBLE_E2E_SHIM ??
		resolve(process.env.CARGO_TARGET_DIR ?? 'target', 'debug/wobble-dev-shim');
	let child: ChildProcess | undefined;
	async function start() {
		await reserve();
		let listening = false;
		let failed = false;
		let readiness = '';
		child = spawn(binary, [], {
			env: {
				...process.env,
				WOBBLE_DB_PATH: database,
				WOBBLE_SHIM_PORT: String(port),
				WOBBLE_STATIC_DIR: resolve('build')
			},
			stdio: ['ignore', 'ignore', 'pipe']
		});
		child.once('error', () => {
			failed = true;
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			readiness = (readiness + chunk.toString()).slice(-1024);
			if (readiness.includes(`listening on ${url}`)) listening = true;
		});
		await expect
			.poll(() => !failed && child?.exitCode === null && listening, {
				message: 'the owned shim binds its allocated port'
			})
			.toBe(true);
		await expect.poll(async () => (await request.get('/api/boot-status')).status()).toBe(200);
	}
	async function stop() {
		const running = child;
		child = undefined;
		if (!running?.pid || running.exitCode !== null || running.signalCode !== null) return;
		const finished = once(running, 'exit');
		const deadline = setTimeout(() => running.kill('SIGKILL'), 5000);
		running.kill('SIGTERM');
		try {
			await finished;
		} finally {
			clearTimeout(deadline);
		}
	}
	return {
		get url() {
			return url;
		},
		database,
		get request() {
			return request;
		},
		start,
		stop,
		async dispose() {
			await stop();
			await request.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	};
}
