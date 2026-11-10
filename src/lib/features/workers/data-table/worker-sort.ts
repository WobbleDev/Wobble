/**
 * Pure sort keys and comparators for the Workers table's columns. A key is `null`
 * when a Worker holds nothing for the column, and empty keys sort last in both
 * directions.
 */
import { assessedOptions, type AssessmentOption } from '#lib/domain-vocabulary.ts';
import type { OptionChoice } from '../answers.ts';

/**
 * Orders two sort keys: present values by `compareValues`, empty values after them.
 *
 * TanStack's engine negates a column sort function's result for descending order,
 * so an empty value's sign is set against `descending` here to land it last either way.
 * Two empties tie, and the engine then keeps their original order.
 */
export function compareWithEmptiesLast<T>(
	first: T | null,
	second: T | null,
	compareValues: (first: T, second: T) => number,
	descending: boolean
): number {
	if (first === null && second === null) return 0;
	if (first === null) return descending ? -1 : 1;
	if (second === null) return descending ? 1 : -1;
	return compareValues(first, second);
}

/** Unassessed is the empty standing; the five assessed standings are values. */
export function assessmentSortKey(assessment: AssessmentOption): AssessmentOption | null {
	return assessment === 'Unassessed' ? null : assessment;
}

/** Orders assessed standings in the scale's order, Leader first. */
export function compareAssessmentScale(first: AssessmentOption, second: AssessmentOption): number {
	const scale: readonly AssessmentOption[] = assessedOptions;
	return scale.indexOf(first) - scale.indexOf(second);
}

/** The held labels as one sort key, in the order given; null when none is held. */
export function labelsSortKey(labels: readonly string[]): string | null {
	return labels.length ? labels.join(', ') : null;
}

/**
 * The sort key for an Attribute's held answer(s): the labels of the held answers
 * in the order the Attribute defines its choices. A Category holds one id (`''`
 * for none), a Tag a list; a held id that matches no choice is ignored.
 */
export function heldLabelsKey(
	heldIds: string | readonly string[],
	choices: readonly OptionChoice[]
): string | null {
	const held = typeof heldIds === 'string' ? [heldIds] : heldIds;
	return labelsSortKey(
		choices.filter((choice) => held.includes(choice.value)).map((choice) => choice.label)
	);
}
