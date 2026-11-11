/**
 * Test fixtures for Attribute answers (ADR 0030). A fixture writes an answer as text
 * and gives it the id the test suite uses, so a definition and the Workers that hold
 * it agree. Mapping code never reads these texts back; only test assertions do.
 */
import type { WorkerAttributeDefinition, WorkerAttributeValues } from '#lib/domain-vocabulary.ts';
import type { WorkerGraphNode } from '#lib/features/mapping/worker-relationship-map-model.ts';

/** The id a fixture gives the answer `text` within the Attribute `attributeId`. */
export function answerIdOf(attributeId: string, text: string): string {
	return `${attributeId}~${text}`;
}

/** An Attribute whose text options are also its answers, each with its id. */
export function attributeFixture(definition: {
	id: string;
	name: string;
	kind: WorkerAttributeDefinition['kind'];
	options: readonly string[];
}): WorkerAttributeDefinition {
	return {
		id: definition.id,
		name: definition.name,
		kind: definition.kind,
		answers: definition.options.map((value) => ({
			id: answerIdOf(definition.id, value),
			value
		}))
	};
}

/** A Worker's answers given as text, held as the ids of those answers. A blank Category stays blank. */
export function answerIdsFixture(values: Record<string, string | string[]>): WorkerAttributeValues {
	return Object.fromEntries(
		Object.entries(values).map(([attributeId, value]) => [
			attributeId,
			Array.isArray(value)
				? value.map((text) => answerIdOf(attributeId, text))
				: value === ''
					? ''
					: answerIdOf(attributeId, value)
		])
	);
}

/** The text a Category node holds for an Attribute, read back from its answer id. */
export function answerText(node: Pick<WorkerGraphNode, 'attributes'>, attributeId: string): string {
	const held = node.attributes?.[attributeId];
	if (typeof held !== 'string' || held === '') return '';
	return held.slice(`${attributeId}~`.length);
}
