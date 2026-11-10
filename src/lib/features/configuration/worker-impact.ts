/**
 * Worker-first Before→After rows for the Configuration preview. Pure: a row is built only
 * from the planner-reply resolution groups (never from the draft), so the review states what
 * the save path will execute with the same resolutions.
 */
import { m } from '#lib/paraglide/messages.js';
import type { PreviewHolderRow, PreviewResolutionGroup } from './configuration-preview.ts';

export type WorkerImpactState = 'retained' | 'removed' | 'unresolved';

export type WorkerImpactRow = {
	key: string;
	workerId: string;
	workerName: string;
	/** The holder's value now, phrased with current names. */
	before: string;
	/** The value after Save; empty while unresolved. */
	after: string;
	state: WorkerImpactState;
};

const NONE = () => m.configuration_preview_no_value();

function impactRow(row: PreviewHolderRow): WorkerImpactRow {
	const base = { key: row.key, workerId: row.workerId, workerName: row.workerName };
	const before = row.summary;

	if (row.attributeRemoval) {
		return { ...base, before, after: NONE(), state: 'removed' };
	}
	if (row.acknowledgement) {
		return row.keeps
			? { ...base, before, after: row.keeps, state: 'retained' }
			: { ...base, before, after: NONE(), state: 'removed' };
	}
	if (row.cardinalitySurface) {
		const retained = row.choice.retained;
		if (retained === undefined) return { ...base, before, after: '', state: 'unresolved' };
		if (retained === null) return { ...base, before, after: NONE(), state: 'removed' };
		const label = row.heldAnswers?.find((answer) => answer.answerId === retained)?.label;
		return label === undefined
			? { ...base, before, after: '', state: 'unresolved' }
			: { ...base, before, after: label, state: 'retained' };
	}
	const replacement = row.choice.replacement;
	if (replacement === undefined) return { ...base, before, after: '', state: 'unresolved' };
	if (replacement === null) return { ...base, before, after: NONE(), state: 'removed' };
	const label = row.replacements.find((candidate) => candidate.answerId === replacement)?.label;
	return label === undefined
		? { ...base, before, after: '', state: 'unresolved' }
		: { ...base, before, after: label, state: 'retained' };
}

/** One entry per affected Worker, in first-seen order, with every holder row it carries. */
export function workerImpact(
	groups: readonly PreviewResolutionGroup[]
): { workerId: string; workerName: string; rows: WorkerImpactRow[] }[] {
	const byWorker = new Map<
		string,
		{ workerId: string; workerName: string; rows: WorkerImpactRow[] }
	>();
	for (const group of groups) {
		for (const holder of group.rows) {
			const entry = byWorker.get(holder.workerId) ?? {
				workerId: holder.workerId,
				workerName: holder.workerName,
				rows: []
			};
			entry.rows.push(impactRow(holder));
			byWorker.set(holder.workerId, entry);
		}
	}
	return [...byWorker.values()];
}
