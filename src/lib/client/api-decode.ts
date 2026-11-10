import { isAppSettings, type AppSettings } from '#lib/shared/app-settings.ts';
import type {
	Agitation,
	ConfigurationPreview,
	ConfigurationPreviewShortForm,
	Language,
	Worker,
	WorkerUpdate
} from '#lib/domain-vocabulary.ts';
import type { AgitationCreatedReply } from '#lib/client/generated/AgitationCreatedReply.ts';
import type { ImportReply } from '#lib/client/generated/ImportReply.ts';
import type { LanguageCreatedReply } from '#lib/client/generated/LanguageCreatedReply.ts';
import type { RuntimeReply } from '#lib/client/generated/RuntimeReply.ts';
import type { ShortFormsReply } from '#lib/client/generated/ShortFormsReply.ts';
import type { WorksiteReply } from '#lib/client/generated/WorksiteReply.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The result of an import commit: how many Workers it created, and each one's source CSV row and id, in request order. */
export type ImportResult = {
	imported: number;
	created: { row: number; id: string }[];
};

/** Narrows a successful import body to its ordered row-to-id pairs. */
export function decodeImportResult(value: unknown): ImportResult {
	const reply = value as ImportReply;
	if (!Array.isArray(reply.created) || reply.created.length !== reply.imported) {
		throw new Error('Server returned an invalid import result.');
	}

	return { imported: reply.imported, created: reply.created.map(({ row, id }) => ({ row, id })) };
}

/** Narrows a successful agitation body to the Agitation it created. */
export function decodeAgitation(value: unknown): Agitation {
	const reply = value as AgitationCreatedReply;

	return reply.agitation;
}

/** Narrows a successful language body to the Language it created. */
export function decodeLanguage(value: unknown): Language {
	const reply = value as LanguageCreatedReply;

	return reply.language;
}

/** Narrows an untrusted Short form suggestions reply to the forms it lists. */
export function decodeShortFormSuggestions(value: unknown): ConfigurationPreviewShortForm[] {
	const reply = value as ShortFormsReply;

	return reply.shortForms;
}

/** Narrows an untrusted preview reply to the report the confirmation renders. */
export function decodeConfigurationPreview(value: unknown): ConfigurationPreview {
	return value as ConfigurationPreview;
}

/** Narrows a successful worksite body to the id the client should remember. */
export function decodeWorksiteId(value: unknown): string {
	const reply = value as WorksiteReply;
	if (reply.worksite === null) {
		throw new Error('Server returned an invalid worksite.');
	}

	return reply.worksite.id;
}

/** Worker counts by Worksite id, from `GET /api/worksite/counts`. */
export function decodeWorksiteCounts(value: unknown): Record<string, number> {
	const counts = isRecord(value) ? value.counts : undefined;
	if (!Array.isArray(counts)) throw new Error('Server returned invalid worksite counts.');
	const byId: Record<string, number> = {};
	for (const entry of counts) {
		if (
			!isRecord(entry) ||
			typeof entry.worksiteId !== 'string' ||
			typeof entry.workers !== 'number' ||
			!Number.isInteger(entry.workers) ||
			entry.workers < 0
		) {
			throw new Error('Server returned invalid worksite counts.');
		}
		byId[entry.worksiteId] = entry.workers;
	}
	return byId;
}

/** The live database file: its path, main-file size, and latest main-or-WAL write. */
export type DataFileInfo = {
	path: string;
	/** The main SQLite file's size in bytes, or null when it cannot be read. */
	sizeBytes: number | null;
	/** The latest write across the main file and its WAL as an ISO instant, or null. */
	modifiedAt: string | null;
};

/** Narrows a successful data-file body; an unreadable field stays null rather than invented. */
export function decodeDataFile(value: unknown): DataFileInfo {
	const path = isRecord(value) ? value.path : undefined;
	if (typeof path !== 'string' || path.length === 0) {
		throw new Error('Server returned an invalid data file path.');
	}

	const size = isRecord(value) ? value.sizeBytes : undefined;
	const sizeBytes = typeof size === 'number' && Number.isInteger(size) && size >= 0 ? size : null;
	const modified = isRecord(value) ? value.modifiedAt : undefined;
	const modifiedAt =
		typeof modified === 'string' && !Number.isNaN(Date.parse(modified)) ? modified : null;

	return { path, sizeBytes, modifiedAt };
}

/** Narrows a successful restore or erase body to the safety copy it wrote. */
export function decodeSafetyCopyPath(value: unknown): string {
	const path = isRecord(value) ? value.safetyCopyPath : undefined;
	if (typeof path !== 'string' || path.length === 0) {
		throw new Error('Server returned an invalid safety copy path.');
	}

	return path;
}

/** The running installation's identity; a value the core could not resolve is null. */
export type RuntimeInfo = {
	appVersion: string | null;
	build: string | null;
	platform: string | null;
	schemaVersion: number | null;
};

/** Narrows a successful runtime body to the installation identity the shell shows. */
export function decodeRuntimeInfo(value: unknown): RuntimeInfo {
	const reply = value as RuntimeReply;

	return {
		appVersion: reply.appVersion,
		build: reply.build,
		platform: reply.platform,
		schemaVersion: reply.schemaVersion
	};
}

/** Narrows a successful settings body to the AppSettings it carries. */
export function decodeSettings(value: unknown): AppSettings {
	const settings = isRecord(value) ? value.settings : undefined;
	if (!isAppSettings(settings)) {
		throw new Error('Settings response was invalid.');
	}

	return settings;
}

/**
 * Narrows one untrusted stored Worker body: a dataset row, a create reply, or a per-field
 * write reply (which carries the whole record). The core validates on write, so the body
 * is taken as the Worker it claims to be.
 */
export function decodeWorker(
	value: unknown,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for call compatibility
	invalidMessage = 'Server returned an invalid Worker.'
): Worker {
	return value as Worker;
}

/**
 * Narrows one untrusted Worker draft's `update`/`base`: the Worker without its identity.
 * The core validates on write, so the body is taken as the WorkerUpdate it claims to be.
 */
export function decodeWorkerUpdate(
	value: unknown,
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for call compatibility
	invalidMessage = 'Server returned an invalid Worker draft.'
): WorkerUpdate {
	return value as WorkerUpdate;
}
