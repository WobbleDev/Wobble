/**
 * Attribute answers as the Workers view reads them (ADR 0030). A Worker holds an
 * answer by id, and filters, sorting, selection and the bulk bar key on that id.
 * The answer's text is only the label the view displays.
 */
import type {
	AssessmentOption,
	Worker,
	WorkerAttributeDefinition,
	WorkerAttributeValue
} from '#lib/domain-vocabulary.ts';
import { assessmentLabel } from '#lib/i18n/assessment.ts';
import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
import { NO_SELECTION_CHOICE, noValueReading } from '#lib/shared/no-value-reading.ts';
import { heldIdsOf, storesList } from '#lib/shared/select-mode.ts';

/** One menu or filter choice: `value` is what the UI keys on, `label` is what it shows. */
export type OptionChoice = {
	value: string;
	label: string;
	/** The secondary reading under the label, used when no selection collides with an answer. */
	description?: string | null;
	/** This choice is the system no-selection reading, not a stored answer. */
	missing?: boolean;
};

/** The choice key for an Attribute's no-selection reading; shared by every view. */
export { NO_SELECTION_CHOICE };

/** Plain option text, where the value is its own label (Assessment, Languages). */
export function textChoices(options: readonly string[]): OptionChoice[] {
	return options.map((option) => ({ value: option, label: option }));
}

/**
 * Assessment choices: keyed by the stored English identifier, labelled with the
 * applied locale's individual standing ("Líder"), so a write always sends the
 * canonical value.
 */
export function assessmentChoices(options: readonly AssessmentOption[]): OptionChoice[] {
	return options.map((option) => ({ value: option, label: assessmentLabel(option) }));
}

/**
 * An Attribute's answers as choices: keyed by answer id, labelled with its text, or with
 * its full path only when another answer shares the text so the branches stay tellable
 * apart (AC3).
 */
export function answerChoices(attribute: WorkerAttributeDefinition): OptionChoice[] {
	return attribute.answers.map((answer) => ({
		value: answer.id,
		label: answerDisplayLabel(attribute.answers, answer.id)
	}));
}

/**
 * An Attribute's filter choices: its answers, plus the shared no-value reading for either
 * cardinality. The system reading is keyed by NO_SELECTION_CHOICE and carries the
 * collision's secondary description when a real answer uses its text.
 */
export function answerFilterChoices(attribute: WorkerAttributeDefinition): OptionChoice[] {
	const choices = answerChoices(attribute);
	const reading = noValueReading(attribute);
	return [
		...choices,
		{
			value: NO_SELECTION_CHOICE,
			label: reading.label,
			description: reading.description,
			missing: true
		}
	];
}

/** The answer id a Category holds for a Worker: `''` when blank. */
export function heldCategoryAnswerId(worker: Worker, attribute: WorkerAttributeDefinition): string {
	return heldIdsOf(attribute, worker.attributes[attribute.id])[0] ?? '';
}

/** The answer ids a Tag holds for a Worker, in the order they were stored. */
export function heldTagAnswerIds(worker: Worker, attribute: WorkerAttributeDefinition): string[] {
	return heldIdsOf(attribute, worker.attributes[attribute.id]);
}

/** The answer id(s) a Worker holds for one Attribute: a Category's id, or a Tag's list. */
export function heldAnswerIds(
	worker: Worker,
	attribute: WorkerAttributeDefinition
): string | string[] {
	return storesList(attribute)
		? heldTagAnswerIds(worker, attribute)
		: heldCategoryAnswerId(worker, attribute);
}

/**
 * The text an Attribute cell reads as: the configured text of the answers held,
 * in their recorded order. No answer reads by the shared no-value rule — No and
 * the Attribute's current name — and only a system reading whose text a real
 * answer also uses adds the secondary No selection.
 */
export function describeAnswerValue(
	attribute: WorkerAttributeDefinition,
	value: WorkerAttributeValue
): string {
	const ids = Array.isArray(value) ? value : value === '' ? [] : [value];
	const labels = ids
		.filter((id) => attribute.answers.some((answer) => answer.id === id))
		.map((id) => answerDisplayLabel(attribute.answers, id));
	if (labels.length > 0) return labels.join(', ');

	const reading = noValueReading(attribute);
	return reading.description ? `${reading.label}, ${reading.description}` : reading.label;
}

/** True when a Worker holds the answer with this id. */
export function holdsAnswer(
	worker: Worker,
	attribute: WorkerAttributeDefinition,
	answerId: string
): boolean {
	const held = heldAnswerIds(worker, attribute);
	return Array.isArray(held) ? held.includes(answerId) : held === answerId;
}
