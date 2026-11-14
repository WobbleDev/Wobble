/**
 * The worksite snapshot the shell loads: the seven fields `+layout.server.ts`
 * used to assemble, fetched as one reply and decoded before anything trusts it.
 */
import type { DatasetReply } from '#lib/client/generated/DatasetReply.ts';
import type {
	Agitation,
	AttributeAnswer,
	Language,
	Worker,
	WorkerAttributeDefinition,
	Worksite
} from '#lib/domain-vocabulary.ts';
import { isAppSettings, type AppSettings } from '#lib/shared/app-settings.ts';
import {
	isAbbreviation,
	isAbbreviationOrigin,
	type AbbreviationOrigin
} from '#lib/shared/abbreviation.ts';
import { decodeAgitation, decodeLanguage, decodeWorker, isRecord } from './api-decode.ts';
import { requestJson } from './request-json.ts';

export type WorksiteDataset = {
	workers: Worker[];
	attributes: WorkerAttributeDefinition[];
	agitations: Agitation[];
	languages: Language[];
	worksite: Worksite | null;
	worksites: Worksite[];
	settings: AppSettings;
};

let primedDataset: { dataset: WorksiteDataset; at: number } | undefined;

export function primeDataset(dataset: WorksiteDataset, now = Date.now()): void {
	primedDataset = { dataset, at: now };
}

export function takePrimedDataset(now = Date.now()): WorksiteDataset | undefined {
	const primed = primedDataset;
	primedDataset = undefined;
	return primed && now - primed.at <= 2000 ? primed.dataset : undefined;
}

function decodeWorksite(value: unknown): Worksite {
	const worksite = value as Worksite;
	return {
		id: worksite.id,
		name: worksite.name,
		committeeGoal: worksite.committeeGoal,
		committeeTarget: worksite.committeeTarget
	};
}

/** Validates one answer list from an untrusted reply: each answer is an id and its label. */
function decodeAnswers(value: unknown): AttributeAnswer[] {
	if (!Array.isArray(value)) throw new Error('Server returned an invalid attribute.');

	return value.map((answer) => {
		if (
			!isRecord(answer) ||
			typeof answer.id !== 'string' ||
			answer.id.length === 0 ||
			typeof answer.value !== 'string'
		) {
			throw new Error('Server returned an invalid attribute.');
		}

		if (
			answer.parentId !== undefined &&
			(typeof answer.parentId !== 'string' || answer.parentId.length === 0)
		) {
			throw new Error('Server returned an invalid attribute.');
		}

		if (answer.mode !== undefined && answer.mode !== 'single' && answer.mode !== 'multi') {
			throw new Error('Server returned an invalid attribute.');
		}

		// A Abbreviation travels with its origin, and the core never sends an over-long one.
		const hasForm = answer.abbreviation !== undefined;
		if (
			hasForm !== (answer.abbreviationOrigin !== undefined) ||
			(hasForm &&
				(!isAbbreviation(answer.abbreviation) || !isAbbreviationOrigin(answer.abbreviationOrigin)))
		) {
			throw new Error('Server returned an invalid attribute.');
		}

		return {
			id: answer.id,
			value: answer.value,
			...(answer.parentId === undefined ? {} : { parentId: answer.parentId }),
			...(answer.mode === undefined ? {} : { mode: answer.mode }),
			...(hasForm
				? {
						abbreviation: answer.abbreviation as string,
						abbreviationOrigin: answer.abbreviationOrigin as AbbreviationOrigin
					}
				: {})
		};
	});
}

/** Narrows one Attribute as the core sends it: its answers carry ids and parent links. */
function decodeAttribute(value: unknown): WorkerAttributeDefinition {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		value.id.length === 0 ||
		typeof value.name !== 'string' ||
		value.name.length === 0 ||
		(value.kind !== 'category' && value.kind !== 'tag')
	) {
		throw new Error('Server returned an invalid attribute.');
	}

	return {
		id: value.id,
		name: value.name,
		kind: value.kind,
		answers: decodeAnswers(value.options)
	};
}

function decodeList<T>(value: unknown, decode: (item: unknown) => T, label: string): T[] {
	if (!Array.isArray(value)) throw new Error(`Server returned an invalid ${label}.`);

	return value.map((item) => decode(item));
}

export function decodeWorksiteDataset(value: unknown): WorksiteDataset {
	if (!isRecord(value) || !isAppSettings(value.settings)) {
		throw new Error('Server returned an invalid dataset.');
	}
	const reply = value as DatasetReply;

	return {
		workers: decodeList(reply.workers, decodeWorker, 'Worker list'),
		attributes: decodeList(reply.attributes, decodeAttribute, 'attribute list'),
		agitations: decodeList(
			reply.agitations,
			(item) => decodeAgitation({ agitation: item }),
			'agitation list'
		),
		languages: decodeList(
			reply.languages,
			(item) => decodeLanguage({ language: item }),
			'language list'
		),
		worksite: reply.worksite == null ? null : decodeWorksite(reply.worksite),
		worksites: decodeList(reply.worksites, decodeWorksite, 'Worksite list'),
		settings: value.settings
	};
}

export function getWorksiteDataset(): Promise<WorksiteDataset> {
	return requestJson(
		'/api/dataset',
		{ cache: 'no-store' },
		(status) => `Could not load the worksite (HTTP ${status}).`,
		decodeWorksiteDataset
	);
}
