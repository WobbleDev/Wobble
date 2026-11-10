import type { RuntimeReply } from '#lib/client/generated/RuntimeReply.ts';
import { requestJson } from './request-json.ts';
import { decodeRuntimeInfo, type RuntimeInfo } from './api-decode.ts';

/**
 * Reads the running installation's identity: build, platform, application version and
 * the active database schema. The core resolves them from the process itself; the
 * browser shows Unavailable for anything it cannot resolve.
 */
export function getRuntimeInfo(): Promise<RuntimeInfo> {
	return requestJson(
		'/api/runtime',
		{},
		(status) => `Could not read the runtime details (HTTP ${status}).`,
		(value) => decodeRuntimeInfo(value as RuntimeReply as unknown)
	);
}
