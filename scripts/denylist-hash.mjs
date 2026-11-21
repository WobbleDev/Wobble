// Shared by the hashed-denylist tools. The private denylist never enters this repo, and neither do
// its hashes: they come from a GitHub Actions secret. A pattern is reduced to its tokens (lowercase
// letters and digits, accents removed, everything else a separator) and the SHA-256 of the token
// sequence is compared with the same hash of every run of up to MAX_TOKENS tokens in the scanned
// text. Both the spaced form ("ada lovelace") and the joined form ("adalovelace") are hashed, and
// the text is also tokenized with camelCase boundaries split ("AdaLovelace"), so the usual ways of
// writing a name in code are covered. Matching is on whole tokens, not substrings.
import { createHash } from 'node:crypto';

export const MAX_TOKENS = 8;
const HASH_LENGTH = 20;
const SALT = 'wobble-denylist-v1\0';

const TOKEN = /[\p{L}\p{N}]+/gu;

export function tokenize(text, { splitCamel = false } = {}) {
	let s = text.normalize('NFKD').replace(/\p{M}+/gu, '');
	if (splitCamel) {
		s = s
			.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
			.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
	}
	return s.toLowerCase().match(TOKEN) ?? [];
}

const digest = (s) =>
	createHash('sha256')
		.update(SALT + s)
		.digest('hex')
		.slice(0, HASH_LENGTH);

/** The "n:hash" entries one denylist line produces, or null when it has no usable tokens. */
export function entriesForPattern(line) {
	const tokens = tokenize(line);
	if (tokens.length === 0 || tokens.length > MAX_TOKENS) return null;
	const n = tokens.length;
	const forms = new Set([tokens.join(' '), tokens.join('')]);
	return [...forms].map((form) => `${n}:${digest(form)}`);
}

/** Parses the secret's value (one "n:hash" per line) into a matcher. */
export function buildMatcher(secretText) {
	const byLength = new Map();
	for (const raw of secretText.split(/\r?\n/)) {
		const m = /^([1-9]):([0-9a-f]{20})$/.exec(raw.trim());
		if (!m) continue;
		const n = Number(m[1]);
		if (!byLength.has(n)) byLength.set(n, new Set());
		byLength.get(n).add(m[2]);
	}
	const lengths = [...byLength.keys()].sort((a, b) => a - b);

	function tokensMatch(tokens) {
		for (const n of lengths) {
			const wanted = byLength.get(n);
			for (let i = 0; i + n <= tokens.length; i++) {
				const run = tokens.slice(i, i + n);
				if (wanted.has(digest(run.join(' '))) || (n > 1 && wanted.has(digest(run.join(''))))) {
					return true;
				}
			}
		}
		return false;
	}

	/** Whether one line of text (or a path, or a commit field) holds a denylisted run of tokens. */
	function lineMatches(line) {
		if (lengths.length === 0) return false;
		const plain = tokenize(line);
		if (tokensMatch(plain)) return true;
		const camel = tokenize(line, { splitCamel: true });
		return camel.length !== plain.length && tokensMatch(camel);
	}

	return { size: lengths.reduce((sum, n) => sum + byLength.get(n).size, 0), lineMatches };
}
