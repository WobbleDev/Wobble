/**
 * The local field example for one draft Attribute: the options a Worker field would offer,
 * from the draft definition alone. Read-only by construction: it imports no client, takes
 * no callbacks, and the example holds its pick in local component state.
 */
import { answerDisplayLabel } from '#lib/shared/answer-path.ts';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';

export type FieldExampleOption = { value: string; label: string };

export function fieldExampleOptions(attribute: WorkerAttributeDefinition): FieldExampleOption[] {
	const parents = new Set(attribute.answers.map((answer) => answer.parentId).filter(Boolean));
	return attribute.answers
		.filter((answer) => !parents.has(answer.id))
		.map((answer) => ({
			value: answer.id,
			label: answerDisplayLabel(attribute.answers, answer.id)
		}));
}
