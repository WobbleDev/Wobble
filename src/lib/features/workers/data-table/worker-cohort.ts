/**
 * The cohort a Workers record walks: the ordered ids the table showed when the record
 * was opened. It is a snapshot, so Previous and Next follow the list the organizer
 * opened the record from, not whatever the filters match now. Each step resolves
 * against the live Workers: a deleted Worker is skipped, never a dead end.
 */

export type CohortPosition = {
	/** The nearest live Worker before the current one, or null at the start. */
	previousId: string | null;
	/** The nearest live Worker after the current one, or null at the end. */
	nextId: string | null;
	/** 1-based place of the current Worker among the live members; null when it is not a member. */
	position: number | null;
	/** How many members are still live. */
	total: number;
};

export function cohortPosition(
	cohort: readonly string[],
	currentId: string | null,
	isLive: (id: string) => boolean
): CohortPosition {
	const live = cohort.filter(isLive);
	const index = currentId === null ? -1 : live.indexOf(currentId);
	if (index >= 0) {
		return {
			previousId: live[index - 1] ?? null,
			nextId: live[index + 1] ?? null,
			position: index + 1,
			total: live.length
		};
	}
	// Not a live member (created or edited out of the list, or reached through a link):
	// position is unknown, but the neighbours by snapshot order still hold when it was a member.
	const at = currentId === null ? -1 : cohort.indexOf(currentId);
	if (at < 0) return { previousId: null, nextId: null, position: null, total: live.length };
	return {
		previousId: [...cohort.slice(0, at)].reverse().find(isLive) ?? null,
		nextId: cohort.slice(at + 1).find(isLive) ?? null,
		position: null,
		total: live.length
	};
}

/** True when a cohort was captured and every member has since been deleted. */
export function cohortExhausted(cohort: readonly string[], isLive: (id: string) => boolean) {
	return cohort.length > 0 && !cohort.some(isLive);
}
