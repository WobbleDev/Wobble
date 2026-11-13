import {
	decodeAgitation,
	decodeConfigurationPreview,
	decodeDataFile,
	decodeImportResult,
	decodeLanguage,
	decodeRuntimeInfo,
	decodeSafetyCopyPath,
	decodeSettings,
	decodeAbbreviationSuggestions,
	decodeWorksiteId,
	isRecord
} from '#lib/client/api-decode.ts';
import { decodeBootStatus } from '#lib/client/boot-api.ts';
import { decodeWorksiteDataset } from '#lib/client/dataset-api.ts';
import { decodeDraft, decodeWorkerReply } from '#lib/client/workers-api.ts';

/** A contact import body: the accepted rows with the Attribute ids the review saw. */
function isReviewedImport(requestBody: unknown) {
	return isRecord(requestBody) && Array.isArray(requestBody.contacts);
}

type Decoder = (body: unknown, requestBody: unknown) => unknown;

/**
 * Each entry is `METHOD path-pattern` (`:name` is one segment) → the decoder that the client
 * function applies to the 2xx body. Calls that do not decode (`requestVoid`) are not listed.
 * The draft reply is unwrapped from `{ draft }` here, as the client's callback does.
 */
const decoders: Record<string, Decoder> = {
	'GET /api/boot-status': (body) => decodeBootStatus(body),
	'GET /api/dataset': (body) => decodeWorksiteDataset(body),
	'GET /api/settings': (body) => decodeSettings(body),
	'PUT /api/settings': (body) => decodeSettings(body),
	'DELETE /api/settings': (body) => decodeSettings(body),
	'POST /api/worksite': (body) => decodeWorksiteId(body),
	'POST /api/workers': (body, requestBody) =>
		Array.isArray(requestBody) || isReviewedImport(requestBody)
			? decodeImportResult(body)
			: decodeWorkerReply(body),
	'PATCH /api/workers/:id': (body) => decodeWorkerReply(body),
	'GET /api/worker-drafts/:id': (body) => decodeDraft(isRecord(body) ? body.draft : undefined),
	'POST /api/agitations': (body) => decodeAgitation(body),
	'POST /api/languages': (body) => decodeLanguage(body),
	'POST /api/configuration/preview': (body) => decodeConfigurationPreview(body),
	'POST /api/configuration/short-forms': (body) => decodeAbbreviationSuggestions(body),
	'GET /api/data-file': (body) => decodeDataFile(body),
	'GET /api/runtime': (body) => decodeRuntimeInfo(body),
	'POST /api/restore': (body) => decodeSafetyCopyPath(body),
	'POST /api/erase': (body) => decodeSafetyCopyPath(body)
};

export function decoderFor(method: string, path: string): Decoder | undefined {
	for (const [key, decoder] of Object.entries(decoders)) {
		const [keyMethod, pattern] = key.split(' ');
		const regex = new RegExp(`^${pattern.replace(/:[a-z]+/g, '[^/]+')}$`);
		if (keyMethod === method && regex.test(path)) return decoder;
	}

	return undefined;
}
