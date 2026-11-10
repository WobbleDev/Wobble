/**
 * The Mapping's contextual filters as the interface reads them: the chips that name an
 * active condition, the empty-state label of each filtered question, and the ordinary
 * answer choices an Attribute offers.
 *
 * The conditions themselves, their identity validation and their population predicates
 * are shared with the Workers view (spec: Filtering, hierarchy, and readings). This
 * module only turns an already-validated selection into names, so the two views cannot
 * describe the same reading differently.
 */
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
import type { ContextualFilters } from '#lib/shared/contextual-filters.ts';
import { NO_SELECTION_CHOICE, noValueReading } from '#lib/shared/no-value-reading.ts';

/** One active contextual condition, as the map names it beside the other filters. */
export type ContextFilterChip = {
	/** A stable key: the condition's typed identity, never its label. */
	key: string;
	/** The Attribute the condition answers. */
	attributeId: string;
	/** The Attribute's current name, so a chip keeps its meaning after a rename. */
	attribute: string;
	/** The selected answer id, or '' for the no-answer reading. */
	value: string;
	/** The reading itself, from the current configuration. */
	label: string;
	/** The system reading's explanatory text when a real answer uses the same label. */
	description: string | null;
	/** The condition is a no-answer reading, not a named answer. */
	missing: boolean;
};

/** One choice in an Attribute's Include dropdown, keyed by answer id. */
export type IncludeFilterChoice = {
	id: string;
	label: string;
	description?: string | null;
};

function answerChip(
	attribute: WorkerAttributeDefinition,
	value: string,
	missing: boolean
): ContextFilterChip {
	const reading = missing ? noValueReading(attribute) : undefined;
	return {
		key: `${missing ? 'missing' : 'answer'}:${attribute.id}:${value}`,
		attributeId: attribute.id,
		attribute: attribute.name,
		value,
		label: reading?.label ?? answerDisplayLabel(attribute.answers, value),
		description: reading?.description ?? null,
		missing
	};
}

/**
 * Every active contextual condition in a stable order: each Attribute's answers, then
 * its no-answer reading. Every condition is a Worker condition, so a shared link from
 * any view names the same population here. A stale id — one the current vocabulary no
 * longer offers — is left out, matching what the population ignores.
 */
export function contextFilterChips(
	filters: ContextualFilters,
	attributes: readonly WorkerAttributeDefinition[]
): ContextFilterChip[] {
	const chips: ContextFilterChip[] = [];
	const ordered = [...attributes].sort((first, second) => first.name.localeCompare(second.name));

	for (const attribute of ordered) {
		for (const value of filters.answers[attribute.id] ?? []) {
			chips.push(answerChip(attribute, value, false));
		}
		if (filters.missing.includes(attribute.id)) {
			chips.push(answerChip(attribute, NO_SELECTION_CHOICE, true));
		}
	}

	return chips;
}

/** The filtered questions the empty map names, without repeating one Attribute. */
export function contextFilterLabels(
	filters: ContextualFilters,
	attributes: readonly WorkerAttributeDefinition[]
): string[] {
	const labels: string[] = [];
	for (const chip of contextFilterChips(filters, attributes)) {
		if (!labels.includes(chip.attribute)) labels.push(chip.attribute);
	}
	return labels;
}

/** The number of filtered questions, the count the Filter control's badge shows. */
export function contextFilterGroupCount(
	filters: ContextualFilters,
	attributes: readonly WorkerAttributeDefinition[]
): number {
	return contextFilterLabels(filters, attributes).length;
}

/**
 * An Attribute's Include choices: its answers by their stable ids, plus the shared
 * no-value reading for either cardinality. The system choice is the shared key, never
 * an answer id, so a real answer keeps its own identity.
 */
export function includeFilterChoices(attribute: WorkerAttributeDefinition): IncludeFilterChoice[] {
	const answers = attribute.answers.map((answer) => ({
		id: answer.id,
		label: answerDisplayLabel(attribute.answers, answer.id)
	}));
	const reading = noValueReading(attribute);
	return [
		...answers,
		{
			id: NO_SELECTION_CHOICE,
			label: reading.label,
			description: reading.description
		}
	];
}
