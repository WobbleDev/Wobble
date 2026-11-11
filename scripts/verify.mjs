#!/usr/bin/env node
// `npm run verify`: run the checks a change needs before it is called done.
// lint, check and test always run, sequentially; test:rust and the affected Playwright
// areas are added from the changed paths (rules: scripts/verify-routing.ts). Writes an
// evidence JSON shaped like .scratch/current-work/reconciliation-browser-acceptance.json.
// Needs a Node that strips TypeScript types (22.18+ or 24).
// The base is `git merge-base HEAD main` (HEAD if that fails), so committed work counts;
// `--base <ref>` overrides it.
// `--e2e-only` drops lint, check, test and test:rust from the plan (CI runs those in their own
// jobs) and keeps only the selected Playwright runs.
// Usage: npm run verify [-- --base <ref>] [--dry-run] [--e2e-only] [--out <file>]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { planChecks, routeChanges } from './verify-routing.ts';

const args = process.argv.slice(2);
const option = (name) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};
const dryRun = args.includes('--dry-run');
const git = (...gitArgs) =>
	spawnSync('git', gitArgs, { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const base = option('--base') ?? git('merge-base', 'HEAD', 'main')[0] ?? 'HEAD';

// Everything that differs from the base in the working tree, staged or not, plus new files.
const changed = [
	...new Set([
		...git('diff', '--name-only', base),
		...git('ls-files', '--others', '--exclude-standard')
	])
].sort();

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const selection = routeChanges(changed, {
	areas: readJson('e2e/areas.json'),
	suites: readJson('e2e/suites.json'),
	uiSpecs: (await import('../e2e/ui-specs.ts')).uiSpecs
});

const freePort = () =>
	new Promise((resolvePort) => {
		const server = createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolvePort(String(port)));
		});
	});

const revision = git('rev-parse', 'HEAD')[0];
const fullPlan = planChecks(selection, await freePort());
const plan = args.includes('--e2e-only')
	? fullPlan.filter((check) => check.name.startsWith('e2e:'))
	: fullPlan;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = resolve('test-results', 'verify');
const runDir = join(evidenceDir, `run-${stamp}`);
const checkDir = (check) => join(runDir, check.name.replace(/:/g, '-'));
const out = option('--out') ?? join(evidenceDir, `verify-${revision.slice(0, 8)}-${stamp}.json`);

console.log(`Base ${base}; ${changed.length} changed path(s).`);
for (const reason of selection.reasons) console.log(`  broadens: ${reason}`);
console.log(`Checks: ${plan.map((check) => check.name).join(' -> ')}`);
if (dryRun) process.exit(0);

// Machine-wide heavy lock (same protocol as scripts/heavy-lock.sh); nested e2e-all.sh skips it.
const heavyLock = join(process.env.TMPDIR || tmpdir(), 'wobble-heavy.lock');
const alive = (pid) => {
	try {
		return (process.kill(pid, 0), true);
	} catch (error) {
		return error.code === 'EPERM';
	}
};
for (let waited = false; ;) {
	try {
		mkdirSync(heavyLock);
		break;
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
	}
	const pid = Number(
		existsSync(join(heavyLock, 'pid')) ? readFileSync(join(heavyLock, 'pid'), 'utf8') : 0
	);
	if (pid && !alive(pid)) {
		rmSync(heavyLock, { recursive: true, force: true });
		continue;
	}
	if (!waited) console.log(`waiting for heavy lock held by ${pid || 'unknown'}`);
	waited = true;
	await new Promise((done) => setTimeout(done, Number(process.env.WOBBLE_HEAVY_POLL ?? 10) * 1000));
}
writeFileSync(join(heavyLock, 'pid'), String(process.pid));
process.env.WOBBLE_HEAVY_LOCK_HELD = '1';
const release = () => rmSync(heavyLock, { recursive: true, force: true });
process.on('exit', release);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

mkdirSync(runDir, { recursive: true });
const startedAt = new Date();
const results = [];
let failed = false;
for (const check of plan) {
	if (failed) {
		results.push({ check: check.name, status: 'skipped', durationMs: 0 });
		continue;
	}
	console.log(`== ${check.name}`);
	const started = Date.now();
	const run = spawnSync(check.command, check.args, {
		stdio: 'inherit',
		env: {
			...process.env,
			CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '1',
			RUST_TEST_THREADS: process.env.RUST_TEST_THREADS ?? '1',
			...check.env,
			...(check.name.startsWith('e2e:') ? { WOBBLE_E2E_RUN_DIR: checkDir(check) } : {})
		}
	});
	const entry = {
		check: check.name,
		status: run.status === 0 ? 'passed' : 'failed',
		exitCode: run.status,
		durationMs: Date.now() - started
	};
	const manifest = join(checkDir(check), 'manifest.json');
	if (check.name.startsWith('e2e:') && existsSync(manifest)) {
		entry.e2e = readJson(manifest).suites.map(
			({ suite, status, discovered, executed, skipped, failed: suiteFailed, durationMs }) => ({
				suite,
				status,
				discovered,
				executed,
				skipped,
				failed: suiteFailed,
				durationMs
			})
		);
	}
	results.push(entry);
	console.log(`== ${check.name} ${entry.status} in ${Math.round(entry.durationMs / 1000)}s`);
	if (run.status !== 0) failed = true;
}

const finishedAt = new Date();
const dirty = git('status', '--porcelain').length > 0;
const evidence = {
	revision,
	dirty,
	base,
	selection: { ...selection, changedPaths: changed, checks: plan.map((check) => check.name) },
	startedAt: startedAt.toISOString(),
	finishedAt: finishedAt.toISOString(),
	durationMs: finishedAt - startedAt,
	versions: { node: process.version },
	// Playwright workers per suite (playwright.config.ts), unless WOBBLE_E2E_WORKERS overrides.
	workers: process.env.WOBBLE_E2E_WORKERS ?? { regular: 2, ui: 3, isolated: 1 },
	results,
	verdict: results.every((entry) => entry.status === 'passed') ? 'passed' : 'failed'
};
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Evidence: ${out}`);
console.log(`Verdict: ${evidence.verdict}`);
process.exit(evidence.verdict === 'passed' ? 0 : 1);
