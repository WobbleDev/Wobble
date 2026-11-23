import type {
	AssessmentOption,
	Worker,
	WorkerAttributeDefinition
} from '#lib/domain-vocabulary.ts';
import { coverageReading, leaderGroups } from './support-summary.ts';

/**
 * The standings a Leader's ties can reach, nearest the centre first. Hostile sits past the
 * drawn bands, and Unassessed is not plotted, so it has no ring to be reached out to.
 */
const REACH_ORDER = ['Activist', 'Supporter', 'Disengaged', 'Hostile'] as const;

type Reached = (typeof REACH_ORDER)[number];

/** A Worker a Leader is tied to, as the pinned row names them. */
export interface TiedWorker {
	id: string;
	name: string;
	assessment: AssessmentOption;
}

/** One Leader as the My Committee column reads them. */
export interface CommitteeMember {
	id: string;
	name: string;
	/** How many other Workers they are tied to, counting a tie from either side. */
	ties: number;
	/** Those Workers, nearest ring first, then by name. */
	tied: TiedWorker[];
	/** How many of them stand in each ring, nearest first; rings nobody stands in are left out. */
	reach: { assessment: AssessmentOption; count: number }[];
	/** The outermost ring their ties reach, or null when none reaches a ring. */
	furthest: Reached | null;
}

/** One run of Leaders in the column: a group of the dashboard's Attribute, or the whole Committee. */
export interface CommitteeSection {
	key: string;
	/** The group's name, or null for the whole Committee when nothing is grouped. */
	label: string | null;
	leaders: number;
	needed: number;
	members: CommitteeMember[];
}

const ringIndex = (assessment: AssessmentOption): number =>
	(REACH_ORDER as readonly string[]).indexOf(assessment);

/**
 * The Organizing Committee as the column lists it: the coverage reading the Committee
 * coverage card shows, and every Leader by name with who their ties reach. With an
 * Attribute that splits the Worksite into more than one group, the Leaders come under
 * the groups the dashboard reads, each with its own coverage, so a group with Workers
 * and no Leader still stands there, empty.
 */
export function committeeReading(
	workers: readonly Worker[],
	attribute: WorkerAttributeDefinition | undefined,
	target: number,
	locale: string
): { coverage: ReturnType<typeof coverageReading>; sections: CommitteeSection[] } {
	const byId = new Map(workers.map((worker) => [worker.id, worker]));
	const collator = new Intl.Collator(locale, { sensitivity: 'base' });
	const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);

	function memberOf(worker: Worker): CommitteeMember {
		const tiedIds = new Set(worker.relationships.filter((id) => byId.has(id)));
		for (const other of workers) if (other.relationships.includes(worker.id)) tiedIds.add(other.id);
		tiedIds.delete(worker.id);
		const tied = [...tiedIds]
			.map((id) => byId.get(id)!)
			.map(({ id, name, assessment }) => ({ id, name, assessment }))
			.sort((a, b) => ringIndex(a.assessment) - ringIndex(b.assessment) || byName(a, b));
		const reach = REACH_ORDER.flatMap((assessment) => {
			const count = tied.filter((entry) => entry.assessment === assessment).length;
			return count > 0 ? [{ assessment, count }] : [];
		});
		return {
			id: worker.id,
			name: worker.name,
			ties: tied.length,
			tied,
			reach,
			furthest: reach.at(-1)?.assessment ?? null
		};
	}

	const coverage = coverageReading(workers, target);
	const groups = leaderGroups(workers, attribute, target);
	const sections: CommitteeSection[] =
		groups.length > 1
			? groups.map(({ reading, leaders }) => ({
					key: `${reading.answerId}${reading.remainder ? ':remainder' : ''}`,
					label: reading.value,
					leaders: reading.leaders,
					needed: reading.needed,
					members: leaders.map(memberOf).sort(byName)
				}))
			: [
					{
						key: 'all',
						label: null,
						leaders: coverage.leaders,
						needed: coverage.needed,
						members: workers
							.filter((worker) => worker.assessment === 'Leader')
							.map(memberOf)
							.sort(byName)
					}
				];
	return { coverage, sections };
}
