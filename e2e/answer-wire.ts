/**
 * E2e seed helpers for the schema-14 wire shape (ADR 0030): an Attribute's answers
 * are `{ id, value }`, and a Worker's answers are answer ids. Seeds keep writing
 * answers as text; these map them to ids deterministically, so a Worker payload and
 * the Attribute it refers to agree without shared state between tests.
 */

export type WireAnswerDefinition = { id: string; value: string };

/** The answer id a seed gives text within one Attribute. Unique per Worksite. */
export function answerId(attributeId: string, text: string): string {
	return `${attributeId}~${text}`;
}

/**
 * Attribute definitions with text answers, sent as answers with ids. The current
 * definition contract is `{ id, name, kind, options }`: no scope or inference metadata.
 */
export function wireDefinitions<T extends { id: string; options: string[] }>(
	definitions: T[]
): Array<Omit<T, 'options'> & { options: WireAnswerDefinition[] }> {
	return definitions.map((definition) => {
		const { options, ...rest } = definition;
		return {
			...rest,
			options: options.map((value) => ({ id: answerId(definition.id, value), value }))
		};
	});
}

/** A Worker's answers given as text, sent as answer ids (a blank Category stays blank). */
export function wireWorkerAttributes(
	values: Readonly<Record<string, string | readonly string[]>>
): Record<string, string | string[]> {
	return Object.fromEntries(
		Object.entries(values).map(([attributeId, value]) => [
			attributeId,
			typeof value === 'string'
				? value === ''
					? ''
					: answerId(attributeId, value)
				: value.map((text) => answerId(attributeId, text))
		])
	);
}
