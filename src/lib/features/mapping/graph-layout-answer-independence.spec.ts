// @module-tag mapping
import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { arrange, type ArrangeInput } from './graph-arrangement.ts';
import { createLayoutQualityFixture, qualityArrangeInput } from './graph-layout-quality-fixture.ts';

const variants = ['grouped', 'nested'] as const;

/** Rewrites every answer id and every Worker's held ids with `relabel`, keeping their order. */
function relabelIds(input: ArrangeInput, relabel: (id: string) => string): ArrangeInput {
	const attributeIds = new Set(
		[input.groupingAttribute, input.subGroupingAttribute].flatMap((a) => (a ? [a.id] : []))
	);
	const attribute = (a: WorkerAttributeDefinition | undefined) =>
		a && { ...a, answers: a.answers.map((answer) => ({ ...answer, id: relabel(answer.id) })) };
	return {
		...input,
		groupingAttribute: attribute(input.groupingAttribute),
		subGroupingAttribute: attribute(input.subGroupingAttribute),
		nodes: input.nodes.map((node) => ({
			...node,
			attributes: Object.fromEntries(
				Object.entries(node.attributes ?? {}).map(([id, held]) => [
					id,
					!attributeIds.has(id)
						? held
						: Array.isArray(held)
							? held.map(relabel)
							: typeof held === 'string' && held !== ''
								? relabel(held)
								: held
				])
			)
		}))
	};
}

/** Rewrites every answer's text, which the layout must never read. */
function retext(input: ArrangeInput): ArrangeInput {
	const attribute = (a: WorkerAttributeDefinition | undefined) =>
		a && {
			...a,
			answers: a.answers.map((answer) => ({ ...answer, value: `Renamed ${answer.id}` }))
		};
	return {
		...input,
		groupingAttribute: attribute(input.groupingAttribute),
		subGroupingAttribute: attribute(input.subGroupingAttribute)
	};
}

function pointsOf(input: ArrangeInput): [string, number, number][] {
	return [...arrange(input).positions]
		.map(([id, p]): [string, number, number] => [id, p.x, p.y])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe('the layout reads an answer by its position, never by its id or text (ADR 0030)', () => {
	const relabels: Record<string, (id: string) => string> = {
		'a reversed id': (id) => [...id].reverse().join(''),
		'a prefixed id': (id) => `zz-9:${id}`,
		'a uuid-like id': (id) => {
			let h = 2166136261;
			for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
			return `${h.toString(16).padStart(8, '0')}-0000-4000-8000-${id.length.toString(16).padStart(12, '0')}`;
		}
	};

	for (const variant of variants) {
		const base = () => qualityArrangeInput(createLayoutQualityFixture(), variant);

		for (const [name, relabel] of Object.entries(relabels)) {
			it(`draws ${variant} identically under ${name}`, () => {
				expect(pointsOf(relabelIds(base(), relabel))).toEqual(pointsOf(base()));
			});
		}

		it(`draws ${variant} identically when only the answers' text changes`, () => {
			expect(pointsOf(retext(base()))).toEqual(pointsOf(base()));
		});
	}
});
