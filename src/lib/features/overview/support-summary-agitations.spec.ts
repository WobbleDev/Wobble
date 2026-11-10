import { describe, expect, it } from 'vitest';
import type {
	Agitation,
	AssessmentOption,
	Worker,
	WorkerAttributeDefinition
} from '../../domain-vocabulary.ts';
import { selectWorkerPopulation } from '../../shared/worker-population.ts';
import { worker as baseWorker } from '../../testing/builders.ts';
import { agitationGroupMatrix, agitationSplits, topAgitationHeadline } from './support-summary.ts';

const worker = (
	name: string,
	assessment: AssessmentOption,
	agitations: string[] = [],
	attributes: Record<string, string | string[]> = {}
) =>
	baseWorker({
		id: name.toLowerCase(),
		name,
		assessment,
		attributes,
		agitations
	});

const agitations: Agitation[] = [
	{ id: 'pay', text: 'Pay' },
	{ id: 'sched', text: 'Scheduling' },
	{ id: 'safety', text: 'Safety' },
	{ id: 'unheld', text: 'Parking' }
];

const job: WorkerAttributeDefinition = {
	id: 'job',
	name: 'Job',
	kind: 'category',
	answers: [
		{ id: 'cashier', value: 'Cashier' },
		{ id: 'stocker', value: 'Stocker' }
	]
};

const crew = (): Worker[] => [
	worker('A', 'Leader', ['sched', 'pay'], { job: 'cashier' }),
	worker('B', 'Unassessed', ['sched'], { job: 'cashier' }),
	worker('C', 'Hostile', ['pay', 'sched'], { job: 'stocker' }),
	worker('D', 'Supporter', ['safety'], { job: 'stocker' }),
	worker('E', 'Supporter', [], { job: 'stocker' })
];

describe('agitationSplits', () => {
	it('splits each held agitation by assessment, most-held first then configured order', () => {
		const rows = agitationSplits({ workers: crew() }, agitations);
		expect(rows.map((r) => [r.id, r.count])).toEqual([
			['sched', 3],
			['pay', 2],
			['safety', 1]
		]);
		expect(rows[0].id).toBe('sched');
		expect(rows[0].levels).toEqual({
			Leader: 1,
			Activist: 0,
			Supporter: 0,
			Disengaged: 0,
			Hostile: 1,
			Unassessed: 1
		});
	});

	it('respects the contextual filter', () => {
		const cashiers = selectWorkerPopulation(crew(), [job], {
			answers: new Map([['job', ['cashier']]])
		});
		expect(agitationSplits(cashiers, agitations).map((r) => [r.id, r.count])).toEqual([
			['sched', 2],
			['pay', 1]
		]);
	});
});

describe('topAgitationHeadline', () => {
	it('reads the share of all workers, Unassessed included', () => {
		expect(topAgitationHeadline({ workers: crew() }, agitations)).toEqual({
			id: 'sched',
			text: 'Scheduling',
			holders: 3,
			total: 5,
			share: 0.6
		});
	});

	it('is null when nothing is held', () => {
		expect(topAgitationHeadline({ workers: [worker('Z', 'Leader')] }, agitations)).toBeNull();
		expect(topAgitationHeadline({ workers: [] }, agitations)).toBeNull();
	});
});

describe('agitationGroupMatrix', () => {
	it('gives each group a count per held agitation and the table maximum', () => {
		const m = agitationGroupMatrix({ workers: crew() }, agitations, job);
		expect(m.columns.map((c) => c.id)).toEqual(['sched', 'pay', 'safety']);
		expect(m.rows.map((r) => [r.value, r.counts])).toEqual([
			['Cashier', [2, 1, 0]],
			['Stocker', [1, 1, 1]]
		]);
		expect(m.max).toBe(2);
	});

	it('is empty without an attribute', () => {
		expect(agitationGroupMatrix({ workers: crew() }, agitations, undefined)).toEqual({
			columns: [],
			rows: [],
			max: 0
		});
	});
});
