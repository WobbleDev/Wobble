/**
 * The no-value reading: how a reading names a Worker who
 * holds no answer to an Attribute. It is "No" plus the Attribute's current
 * configured name, so renaming Department to Team changes the reading to No Team.
 *
 * The reading is the system's, not an answer. A real answer whose text happens to
 * match keeps that text unchanged; only in that collision does the system reading
 * add the secondary description "No selection", so the two stay distinguishable.
 * User answer labels are never rewritten, reserved or matched by anything here.
 */
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';

/**
 * The choice key for an Attribute's no-answer reading. It is the empty string, never an
 * answer id, so a real answer can never take its place.
 */
export const NO_SELECTION_CHOICE = '';

export type NoValueReading = {
	/** The reading itself: "No" and the Attribute's current configured name. */
	label: string;
	/** The secondary description that separates this reading from a matching real answer. */
	description: string | null;
};

/**
 * A Worker's answer reading: the configured answer text it already holds, or the
 * shared no-value reading when it holds none. A colliding real answer keeps its text.
 */
export function answerValueReading(
	attribute: Pick<WorkerAttributeDefinition, 'name' | 'answers'>,
	value: string | string[] | undefined
): string {
	const text = Array.isArray(value) ? value.join(', ') : (value ?? '');
	if (text.length > 0) return text;

	const reading = noValueReading(attribute);
	return reading.description ? `${reading.label}, ${reading.description}` : reading.label;
}

/** The reading for one Attribute, named from its current configuration. */
export function noValueReading(
	attribute: Pick<WorkerAttributeDefinition, 'name' | 'answers'>
): NoValueReading {
	const label = `No ${attribute.name}`;
	return {
		label,
		description: hasRealAnswer(attribute, label) ? 'No selection' : null
	};
}

function hasRealAnswer(
	attribute: Pick<WorkerAttributeDefinition, 'answers'>,
	label: string
): boolean {
	return attribute.answers.some((answer) => answer.value === label);
}
