#!/usr/bin/env node
// Turns the private denylist file into the value of the DENYLIST_HASHES Actions secret.
// Usage: node scripts/make-denylist-hashes.mjs <path-to-denylist.txt> | gh secret set DENYLIST_HASHES --repo WobbleDev/Wobble
// Reads the one file you name (never a folder). Writes only hashes to stdout, and counts (never
// patterns) to stderr. Run it on your own machine; the denylist never goes into the repo.
import { readFileSync, statSync } from 'node:fs';
import { entriesForPattern, MAX_TOKENS } from './denylist-hash.mjs';

const path = process.argv[2];
if (!path) {
	console.error('Usage: node scripts/make-denylist-hashes.mjs <path-to-denylist.txt>');
	process.exit(2);
}
if (!statSync(path).isFile()) {
	console.error('The argument must be the denylist file itself, not a folder.');
	process.exit(2);
}

const lines = readFileSync(path, 'utf8').split(/\r?\n/);
const entries = new Set();
let used = 0;
let unusable = 0;
for (const line of lines) {
	if (line.trim() === '') continue;
	const e = entriesForPattern(line);
	if (!e) {
		unusable++;
		continue;
	}
	used++;
	for (const x of e) entries.add(x);
}
const out = [...entries].sort().join('\n') + '\n';
process.stdout.write(out);
console.error(
	`${used} pattern(s) hashed into ${entries.size} entr${entries.size === 1 ? 'y' : 'ies'}; ` +
		`${unusable} line(s) skipped (no letters or digits, or more than ${MAX_TOKENS} tokens).`
);
if (out.length > 45000) {
	console.error(
		'WARNING: over 45 KB; a GitHub Actions secret holds at most 48 KB. Split or trim the list.'
	);
	process.exitCode = 1;
}
if (used === 0) {
	console.error('WARNING: no usable patterns found.');
	process.exitCode = 1;
}
