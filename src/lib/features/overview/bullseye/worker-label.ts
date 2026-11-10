/**
 * Where a Worker's name sits on the bullseye, and how it is shortened to fit.
 */
import type { Worker } from '#lib/domain-vocabulary.ts';
import { assessmentLabel } from '#lib/i18n/assessment.ts';
import { m } from '#lib/paraglide/messages.js';

/** A worker's accessible name: the one string the dots and every tooltip show. */
export function workerLabel(worker: Worker): string {
	return m.overview_worker_label({
		name: worker.name,
		assessment: assessmentLabel(worker.assessment)
	});
}

/** A highlighted worker's name tag: where their dot sits in the chart's 256-unit space. */
export interface NameTag {
	id: string;
	name: string;
	cx: number;
	cy: number;
}
