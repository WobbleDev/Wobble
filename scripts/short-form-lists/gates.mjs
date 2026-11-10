// Automatic gates for sourced Short form pairs (ADR 0046, ticket 05, spec "Sources").
//
// A candidate pair is kept only when all of these hold:
//   - the short form starts with the expansion's first letter,
//   - its letters appear in order in the expansion,
//   - it is shorter than the expansion,
//   - it matches as an exact phrase on whole-word boundaries (structural: the
//     extractors only ever emit whole names or whole words as expansions).
//
// Pure functions: no I/O, no network. Tested in build.spec.ts.

/** NFC, trimmed, inner whitespace collapsed to single spaces. */
export function normalizePhrase(text) {
	return text.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Lowercase comparison key. Accents are kept: administracion !== administración. */
export function keyOf(text) {
	return normalizePhrase(text).toLowerCase();
}

/** The letters of a phrase in order, lowercased (Unicode letters only). */
export function lettersOf(text) {
	return [...normalizePhrase(text).toLowerCase()].filter((char) => /\p{L}/u.test(char));
}

/**
 * Whether every letter of `short` appears in `expansion` in the same order.
 * Punctuation in the short form (dept., n.) is ignored; only letters must align.
 */
export function lettersInOrder(short, expansion) {
	const needle = lettersOf(short);
	const haystack = lettersOf(expansion);
	if (needle.length === 0) return false;
	let at = 0;
	for (const char of haystack) {
		if (char === needle[at]) {
			at += 1;
			if (at === needle.length) return true;
		}
	}
	return false;
}

/**
 * The spec gates for one (short, expansion) pair.
 * Returns { ok: true } or { ok: false, reason } with reason one of
 * 'empty', 'not-shorter', 'first-letter' or 'letter-order'.
 */
export function gatePair(short, expansion) {
	const cleanShort = normalizePhrase(short);
	const cleanExpansion = normalizePhrase(expansion);
	if (cleanShort === '' || cleanExpansion === '') return { ok: false, reason: 'empty' };
	if ([...cleanShort].length >= [...cleanExpansion].length) {
		return { ok: false, reason: 'not-shorter' };
	}
	const firstShort = lettersOf(cleanShort)[0];
	const firstExpansion = lettersOf(cleanExpansion)[0];
	if (firstShort === undefined || firstExpansion === undefined || firstShort !== firstExpansion) {
		return { ok: false, reason: 'first-letter' };
	}
	if (!lettersInOrder(cleanShort, cleanExpansion)) {
		return { ok: false, reason: 'letter-order' };
	}
	return { ok: true };
}

/**
 * Split candidate pairs into kept and dropped (with the failing gate named).
 * Every expansion of an ambiguous short form is kept: pairs are judged one by one
 * and never deduplicated across expansions, so the worksite conflict check
 * (ADR 0046) can find the other expansions.
 */
export function applyGates(pairs) {
	const kept = [];
	const dropped = [];
	for (const pair of pairs) {
		const verdict = gatePair(pair.short, pair.expansion);
		if (verdict.ok) kept.push(pair);
		else dropped.push({ ...pair, reason: verdict.reason });
	}
	return { kept, dropped };
}
