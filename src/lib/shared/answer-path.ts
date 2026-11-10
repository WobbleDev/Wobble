/**
 * The path of an Attribute answer (GLOSSARY.md): the root-to-answer chain that makes
 * same-named answers in different branches distinguishable. Answer identity is still the
 * id (ADR 0030); a path is only how the interface names one answer next to another.
 */
import type { AttributeAnswer } from '#lib/domain-vocabulary.ts';
import { normalizeForMatch } from './text.ts';

const PATH_SEPARATOR = ' / ';

/** The answers from the root down to this one, inclusive; empty when it is not defined. */
export function answerPath(
	answers: readonly AttributeAnswer[],
	answerId: string
): AttributeAnswer[] {
	const byId = new Map(answers.map((answer) => [answer.id, answer]));
	const path: AttributeAnswer[] = [];
	const seen = new Set<string>();

	let current = byId.get(answerId);
	while (current) {
		// A stored cycle cannot happen through the core's guard, but a decoded reply is
		// untrusted: report no path rather than looping forever.
		if (seen.has(current.id)) return [];
		seen.add(current.id);
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	return path;
}

/** The full path as one label, e.g. "Central / Store A". */
export function answerPathLabel(answers: readonly AttributeAnswer[], answerId: string): string {
	const path = answerPath(answers, answerId);
	return path.length > 0 ? path.map((answer) => answer.value).join(PATH_SEPARATOR) : answerId;
}

/**
 * The label a selector or summary shows: the answer's own text, unless another answer
 * shares it, in which case the full path separates them. Unique labels stay short.
 */
export function answerDisplayLabel(answers: readonly AttributeAnswer[], answerId: string): string {
	const answer = answers.find((candidate) => candidate.id === answerId);
	if (!answer) return answerId;

	const wanted = normalizeForMatch(answer.value);
	const repeats = answers.some(
		(candidate) => candidate.id !== answer.id && normalizeForMatch(candidate.value) === wanted
	);
	return repeats ? answerPathLabel(answers, answerId) : answer.value;
}
