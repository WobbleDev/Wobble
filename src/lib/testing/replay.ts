import { afterEach, beforeEach } from 'vitest';
import { initApiTransport } from '#lib/client/transport.ts';
import type { ApiRecording } from '#lib/client/replay.ts';

/** Answers the client's API calls from `recordings` for each test in the enclosing suite. */
export function useReplay(recordings: readonly ApiRecording[]): void {
	beforeEach(() => initApiTransport('replay', recordings));
	afterEach(() => initApiTransport('http'));
}
