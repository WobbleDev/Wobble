#!/usr/bin/env node
// The old-name guard for the committee-goal / abbreviation renames. Once a rename has been
// contracted, its old names may appear only where they are history: the retained migration
// steps, the tests that exercise them, and the one handler check that refuses the retired wire
// name. Anywhere else a match fails the build, so an old name cannot creep back in.
// Prints file paths and counts only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Names that were contracted away. */
const OLD_NAMES = /committee_target|committeeTarget/;

/** The places where an old name is allowed. Keep this list short. */
const ALLOWED = new Set([
	// Historical migration steps (v25 expand, v27 contract) and their unit tests.
	'crates/wobble-core/src/schema.rs',
	// The 400 for a request that still carries the retired wire name, and its tests.
	'crates/wobble-core/src/handlers/worksite.rs',
	// Migration tests that build and open databases from before the contract.
	'crates/wobble-core/tests/committee_goal_migration.rs',
	'crates/wobble-core/tests/common/legacy_db.rs',
	// Documents the retired name in the route table.
	'contract/route-table.md',
	// This guard.
	'scripts/check-old-names.mjs'
]);

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
	.split('\0')
	.filter(Boolean);

const offenders = [];
for (const file of files) {
	// The retained v12/v20 database fixtures are historical by definition.
	if (ALLOWED.has(file) || file.endsWith('.sqlite')) continue;
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		continue;
	}
	if (OLD_NAMES.test(text)) {
		const count = text.split('\n').filter((line) => OLD_NAMES.test(line)).length;
		offenders.push(`${file}: ${count} line(s)`);
	}
}

if (offenders.length > 0) {
	console.error('old-names: a contracted name is still in use outside the allowed history:');
	for (const offender of offenders) console.error(`  ${offender}`);
	process.exit(1);
}
console.log(`old-names: clean (${files.length} files scanned)`);
