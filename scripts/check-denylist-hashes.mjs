#!/usr/bin/env node
// CI check: fails when tracked files, their paths, or the commit metadata of a range hold a string
// from the private denylist. The denylist is known only as hashes, in the DENYLIST_HASHES secret
// (see scripts/make-denylist-hashes.mjs). Output is counts, file paths and line numbers only,
// never matched text; a path that itself matches is counted, not named.
// Usage: node scripts/check-denylist-hashes.mjs [--range <rev-range>] [--require]
//   DENYLIST_HASHES   the secret's value (environment only, never an argument)
//   --range           also scan author, committer and message of these commits (e.g. base..head)
//   --require         fail instead of skipping when no hashes are available (for local runs)
// Without hashes (a fork PR or Dependabot PR gets no secrets, or the secret is not created yet)
// the check passes with a notice.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { buildMatcher } from './denylist-hash.mjs';

const args = process.argv.slice(2);
const require = args.includes('--require');
const rangeAt = args.indexOf('--range');
const range = rangeAt >= 0 ? args[rangeAt + 1] : '';

const secret = process.env.DENYLIST_HASHES ?? '';
const matcher = buildMatcher(secret);
if (matcher.size === 0) {
	const why =
		'no denylist hashes are available (the DENYLIST_HASHES secret is not set, or this run, such as a fork or Dependabot PR, cannot read it)';
	if (require) {
		console.error(`denylist: ${why}.`);
		process.exit(1);
	}
	const note = `Denylist check skipped: ${why}.`;
	console.log(process.env.GITHUB_ACTIONS ? `::notice title=Denylist check skipped::${note}` : note);
	process.exit(0);
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
const SKIP_FILE =
	/\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|zip|gz|pdf)$|(^|\/)(package-lock\.json|Cargo\.lock)$/i;
const MAX_BYTES = 2_000_000;

const files = git('ls-files', '-z').split('\0').filter(Boolean);
let scanned = 0;
let pathHits = 0;
const contentHits = new Map(); // path -> line numbers
for (const file of files) {
	if (matcher.lineMatches(file)) pathHits++;
	if (SKIP_FILE.test(file)) continue;
	let buf;
	try {
		if (statSync(file).size > MAX_BYTES) continue;
		buf = readFileSync(file);
	} catch {
		continue; // a submodule or a file removed from the work tree
	}
	if (buf.includes(0)) continue;
	scanned++;
	const lines = buf.toString('utf8').split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (matcher.lineMatches(lines[i])) {
			if (!contentHits.has(file)) contentHits.set(file, []);
			contentHits.get(file).push(i + 1);
		}
	}
}

let commits = 0;
const commitHits = [];
if (range) {
	const shas = git('rev-list', range).split('\n').filter(Boolean);
	commits = shas.length;
	for (const sha of shas) {
		const meta = git('log', '-1', '--format=%an%n%ae%n%cn%n%ce%n%B', sha);
		if (meta.split('\n').some((l) => matcher.lineMatches(l))) commitHits.push(sha.slice(0, 10));
	}
}

console.log(`denylist: scanned ${scanned} files, ${files.length} paths and ${commits} commits.`);
const contentTotal = [...contentHits.values()].reduce((n, l) => n + l.length, 0);
if (contentTotal + pathHits + commitHits.length === 0) {
	console.log('denylist: clean.');
	process.exit(0);
}
console.error(
	`denylist: FAILED. ${contentTotal} line hit(s) in ${contentHits.size} file(s), ${pathHits} matching path(s), ${commitHits.length} commit(s) with hits. Matched text is intentionally not printed.`
);
for (const [file, lines] of contentHits) {
	if (!matcher.lineMatches(file)) console.error(`  ${file}: line(s) ${lines.join(', ')}`);
}
for (const sha of commitHits) console.error(`  commit ${sha}: author, committer or message`);
process.exit(1);
