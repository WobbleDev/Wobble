/**
 * The one display mapping for Assessment values.
 *
 * Stored values stay the English contract identifiers. This module only chooses the
 * visible English or Spanish label, with an individual and a group form. Unassessed is
 * not part of the five-level scale; it keeps its own distinct label.
 */
import type { AssessmentOption } from '#lib/domain-vocabulary.ts';
import { m } from '#lib/paraglide/messages.js';

type LabelPair = { one: () => string; many: () => string };

const labels: Record<AssessmentOption, LabelPair> = {
	Unassessed: { one: m.assessment_unassessed, many: m.assessment_unassessed },
	Leader: { one: m.assessment_leader, many: m.assessment_leaders },
	Activist: { one: m.assessment_activist, many: m.assessment_activists },
	Supporter: { one: m.assessment_supporter, many: m.assessment_supporters },
	Disengaged: { one: m.assessment_disengaged, many: m.assessment_disengaged_plural },
	Hostile: { one: m.assessment_hostile, many: m.assessment_hostiles }
};

/** One Worker's standing: Líder, Activista, Sin evaluar. */
export function assessmentLabel(option: AssessmentOption): string {
	return labels[option].one();
}

/** A group of Workers in one standing: Líderes, Activistas, Sin evaluar. */
export function assessmentGroupLabel(option: AssessmentOption): string {
	return labels[option].many();
}
