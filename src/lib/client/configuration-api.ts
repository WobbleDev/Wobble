import type {
	Agitation,
	AttributeAnswer,
	ConfigurationPreview,
	ConfigurationPreviewAbbreviation,
	ConfigurationResolutions,
	Language
} from '#lib/domain-vocabulary.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	decodeAgitation,
	decodeConfigurationPreview,
	decodeAbbreviationSuggestions
} from './api-decode.ts';
import { jsonInit, localizedJsonInit, requestJson, requestVoid } from './request-json.ts';

/** An Attribute answer in a Save payload; `mergedInto` folds it into the surviving answer's id. */
type AttributeAnswerWrite = AttributeAnswer & { mergedInto?: string };

/** An Attribute as the Save payload carries it: its answers, with ids and any merge marker. */
export type AttributeWrite = {
	id: string;
	name: string;
	kind: WorkerAttributeDefinition['kind'];
	options: AttributeAnswerWrite[];
};

/** The Save shapes an Attribute list travels as, so a save and a preview never disagree. */
export function attributeWrites(
	attributes: readonly WorkerAttributeDefinition[]
): AttributeWrite[] {
	return attributes.map((attribute) => ({
		id: attribute.id,
		name: attribute.name,
		kind: attribute.kind,
		options: attribute.answers
	}));
}

/** Saves the Worksite's Attributes; each answer is sent with the id it was minted or kept under. */
export async function saveAttributes(attributes: WorkerAttributeDefinition[]): Promise<void> {
	await requestVoid(
		'/api/attributes',
		localizedJsonInit('PUT', attributeWrites(attributes)),
		(status) => `Could not save attributes (HTTP ${status}).`
	);
}

/** The Save that removes a held leaf answer and carries each holder's resolution. */
export type ConfigurationAttributeSave = {
	attributes: AttributeWrite[];
	/** The preview base; the core refuses a stale one before writing anything. */
	base: string;
	resolutions: ConfigurationResolutions;
};

/**
 * Saves the Attributes together with the explicit resolutions of every affected Worker
 * value and draft surface. One request, one transaction: the preview base is rechecked and
 * a stale, incomplete or invalid plan writes nothing.
 */
export async function saveConfigurationAttributes(save: ConfigurationAttributeSave): Promise<void> {
	await requestVoid(
		'/api/attributes',
		localizedJsonInit('PUT', save),
		(status) => `Could not save attributes (HTTP ${status}).`
	);
}

/** An Agitation in a Save payload; `mergedInto` folds it into the surviving Agitation's id. */
export type AgitationWrite = Agitation & { mergedInto?: string };

/** A Language in a Save payload; `mergedInto` folds it into the surviving Language's id. */
export type LanguageWrite = Language & { mergedInto?: string };

/**
 * The three proposed sets the Configuration preview reconciles, in the Save shapes and
 * with the current merge markers. All three are required; the core refuses a missing one.
 */
export type ConfigurationPreviewRequest = {
	attributes: AttributeWrite[];
	agitations: AgitationWrite[];
	languages: LanguageWrite[];
};

/**
 * Asks the core what a proposed Save all would change. Read-only: the reply is validated
 * like every other untrusted body, and the draft remains the only thing a caller mutates.
 */
export function previewConfiguration(
	request: ConfigurationPreviewRequest
): Promise<ConfigurationPreview> {
	return requestJson(
		'/api/configuration/preview',
		localizedJsonInit('POST', request),
		(status) => `Could not check these changes (HTTP ${status}).`,
		decodeConfigurationPreview
	);
}

/**
 * Asks the core for the Abbreviation each value of a proposed Save would be stored with. Read
 * only and light: no impacts are computed, so it can follow every edit.
 */
export function suggestAbbreviations(
	request: ConfigurationPreviewRequest
): Promise<ConfigurationPreviewAbbreviation[]> {
	return requestJson(
		'/api/configuration/abbreviations',
		localizedJsonInit('POST', request),
		(status) => `Could not suggest Abbreviations (HTTP ${status}).`,
		decodeAbbreviationSuggestions
	);
}

export async function saveAgitations(agitations: AgitationWrite[]): Promise<void> {
	await requestVoid(
		'/api/agitations',
		jsonInit('PUT', agitations),
		(status) => `Could not save agitations (HTTP ${status}).`
	);
}

export async function saveLanguages(languages: LanguageWrite[]): Promise<void> {
	await requestVoid(
		'/api/languages',
		jsonInit('PUT', languages),
		(status) => `Could not save languages (HTTP ${status}).`
	);
}

export async function deleteWorksite(): Promise<void> {
	await requestVoid(
		'/api/worksite',
		{ method: 'DELETE' },
		(status) => `Could not delete the worksite (HTTP ${status}).`
	);
}

export async function saveWorksiteName(name: string): Promise<void> {
	await requestVoid(
		'/api/worksite',
		jsonInit('PUT', { name }),
		(status) => `Could not save the worksite name (HTTP ${status}).`
	);
}

export async function saveWorksiteCommitteeGoal(committeeGoal: number): Promise<void> {
	await requestVoid(
		'/api/worksite',
		jsonInit('PUT', { committeeGoal }),
		(status) => `Could not save the committee coverage goal (HTTP ${status}).`
	);
}

/** Creates the agitation, or returns the worksite's existing agitation with the same text. */
export function createAgitation(text: string): Promise<Agitation> {
	return requestJson(
		'/api/agitations',
		jsonInit('POST', { text }),
		(status) => `Could not add the Agitation (HTTP ${status}).`,
		decodeAgitation
	);
}
