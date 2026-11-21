import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { buildMatcher, entriesForPattern } from './denylist-hash.mjs';

// Synthetic names only. The real denylist and its hashes never enter the repo.
const secretFor = (...patterns: string[]) =>
	patterns.flatMap((p) => entriesForPattern(p) ?? []).join('\n');

describe('hashed denylist matching', () => {
	const matcher = buildMatcher(
		secretFor('Zorvin Q. Plumbwick-Test', 'zz.sample99@mail.invalid', 'Quillfeather')
	);

	it('matches a name however it is spaced, cased or punctuated', () => {
		expect(matcher.lineMatches('Contact: zorvin q plumbwick test about it')).toBe(true);
		expect(matcher.lineMatches('ZORVIN Q. PLUMBWICK-TEST')).toBe(true);
		expect(matcher.lineMatches('const ZorvinQPlumbwickTest = 1')).toBe(true);
		expect(matcher.lineMatches('zorvin_q_plumbwick_test')).toBe(true);
	});

	it('matches an email address and a single word as whole tokens', () => {
		expect(matcher.lineMatches('mail ZZ.Sample99@mail.invalid now')).toBe(true);
		expect(matcher.lineMatches('the Quillfeather flew')).toBe(true);
		expect(matcher.lineMatches('quillfeathers')).toBe(false);
	});

	it('does not match partial or reordered text', () => {
		expect(matcher.lineMatches('zorvin plumbwick')).toBe(false);
		expect(matcher.lineMatches('plumbwick zorvin q test')).toBe(false);
		expect(matcher.lineMatches('')).toBe(false);
	});

	it('ignores accents', () => {
		expect(matcher.lineMatches('Quíllfeather')).toBe(true);
	});

	it('skips lines with no usable tokens and keeps hashes out of the clear', () => {
		expect(entriesForPattern('---')).toBeNull();
		expect(entriesForPattern('a b c d e f g h i')).toBeNull();
		const entries = entriesForPattern('Quillfeather') ?? [];
		expect(entries.join('')).not.toMatch(/quillfeather/i);
	});

	it('matches nothing when the secret is empty', () => {
		expect(buildMatcher('').size).toBe(0);
		expect(buildMatcher('').lineMatches('Quillfeather')).toBe(false);
	});
});
