import type { Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { answerLabels, coverageReading } from './support-summary.ts';

/** One Leader as the My Committee column reads them: their name and one line of context. */
export interface CommitteeMember {
	id: string;
	name: string;
	/** The Worker's answer to the first Category Attribute, or empty when they hold none. */
	detail: string;
}

/**
 * The Organizing Committee as the column lists it: every Leader by name, with the
 * coverage reading the Committee coverage card shows beside them. The context line
 * reads the same Attribute the dashboard groups by first (the first Category).
 */
export function committeeMembers(
	workers: readonly Worker[],
	attributes: readonly WorkerAttributeDefinition[],
	target: number,
	locale: string
): { members: CommitteeMember[]; coverage: ReturnType<typeof coverageReading> } {
	const context = attributes.find((attribute) => attribute.kind === 'category');
	const collator = new Intl.Collator(locale, { sensitivity: 'base' });
	const members = workers
		.filter((worker) => worker.assessment === 'Leader')
		.map((worker) => {
			const label = context ? answerLabels(worker, context) : '';
			return {
				id: worker.id,
				name: worker.name,
				detail: Array.isArray(label) ? label.join(', ') : label
			};
		})
		.sort((a, b) => collator.compare(a.name, b.name));
	return { members, coverage: coverageReading(workers, target) };
}
