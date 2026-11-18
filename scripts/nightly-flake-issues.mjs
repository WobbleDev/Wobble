#!/usr/bin/env node
// Files one issue per spec a nightly run failed, so the failure is visible in the tracker
// instead of only in a runner log that expires.
//
// This repository is public, so an issue carries the spec path and the run link and nothing
// else: never a test title, error, stack, screenshot, trace or attachment. A spec path is
// only used when it looks like one in this repository, so a report cannot make the script
// publish an arbitrary string.
//
// Usage: node scripts/nightly-flake-issues.mjs <report-directory> [--dry-run]
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_SERVER_URL come from Actions.
//   NIGHTLY_JOB names the failing job (chromium or webkit) for the issue body.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A failing report field is only used when it looks like a spec path in this repository. */
const SPEC_PATH = /^[a-z0-9][a-z0-9_./-]*\.spec\.ts$/i;

/** Issues filed in one run are capped, so a run where everything failed cannot mass-file. */
export const MAX_ISSUES = 10;

/** The marker dedupe looks for in open issue titles. */
export function issueTitle(spec) {
	return `[nightly-flake] ${spec}`;
}

/** Every spec file with a test that failed after its retries, from any number of reports. */
export function failedSpecs(reports) {
	const failed = new Set();
	const visit = (suite, inherited) => {
		// A file suite carries `file`; the describe suites nested inside it do not.
		const file = suite.file ?? inherited;
		for (const spec of suite.specs ?? []) {
			const ok =
				spec.ok !== false && !(spec.tests ?? []).some((test) => test.status === 'unexpected');
			if (ok) continue;
			const reported = String(spec.file ?? file ?? '');
			if (SPEC_PATH.test(reported)) failed.add(reported);
		}
		for (const child of suite.suites ?? []) visit(child, file);
	};
	for (const report of reports) for (const suite of report.suites ?? []) visit(suite, undefined);
	return [...failed].sort();
}

/**
 * What the run will do for each failing spec, capped. `open` maps a filed issue's title to
 * its number, so a spec that already has an open issue is commented on instead of filed.
 */
export function plan(specs, open, limit = MAX_ISSUES) {
	return specs.slice(0, limit).map((spec) => {
		const title = issueTitle(spec);
		return { spec, title, issue: open.get(title) ?? null };
	});
}

/** Parses every JSON report in the directory; a missing or unreadable one is skipped. */
export function readReports(directory) {
	let names;
	try {
		names = readdirSync(directory)
			.filter((name) => name.endsWith('.json'))
			.sort();
	} catch {
		return [];
	}
	const reports = [];
	for (const name of names) {
		try {
			reports.push(JSON.parse(readFileSync(join(directory, name), 'utf8')));
		} catch (error) {
			console.log(`skipped ${name}: ${error.message}`);
		}
	}
	return reports;
}

async function github(path, token, init = {}) {
	const response = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			'x-github-api-version': '2022-11-28',
			...init.headers
		}
	});
	if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status})`);
	return response.json();
}

/** The open issues this script filed, by title, so a spec keeps one issue. */
async function openIssues(token, repository) {
	const query = `repo:${repository} is:issue is:open in:title "[nightly-flake]"`;
	const found = await github(`/search/issues?q=${encodeURIComponent(query)}`, token);
	const open = new Map();
	for (const item of found.items ?? []) {
		if (!item.pull_request) open.set(item.title, item.number);
	}
	return open;
}

async function commentOn({ number, spec, token, repository, job, runUrl }) {
	await github(`/repos/${repository}/issues/${number}/comments`, token, {
		method: 'POST',
		body: JSON.stringify({
			body: `The **${job}** job failed in \`${spec}\` again: ${runUrl}`
		})
	});
	return `commented on #${number}`;
}

async function file({ title, spec, token, repository, job, runUrl }) {
	const created = await github(`/repos/${repository}/issues`, token, {
		method: 'POST',
		body: JSON.stringify({
			title,
			labels: ['nightly-flake'],
			body: [
				`The nightly **${job}** job failed in \`${spec}\`.`,
				'',
				`Run: ${runUrl}`,
				'',
				'Filed automatically. This issue carries the spec and the run link only; a later run that fails in the same spec comments here instead of filing again.'
			].join('\n')
		})
	});
	return `opened #${created.number}`;
}

/**
 * Files or comments on every failing spec, in order, and returns what happened. Exported so a
 * spec can drive it with a stubbed `fetch` and assert exactly what reaches GitHub.
 */
export async function fileFailures(specs, { token, repository, job, runUrl, limit = MAX_ISSUES }) {
	const context = { token, repository, job, runUrl };
	const filed = [];
	for (const entry of plan(specs, await openIssues(token, repository), limit)) {
		const failure = { spec: entry.spec, ...context };
		const outcome = entry.issue
			? await commentOn({ number: entry.issue, ...failure })
			: await file({ title: entry.title, ...failure });
		filed.push({ title: entry.title, outcome });
	}
	return filed;
}

async function main() {
	const [directory = 'e2e-reports', ...flags] = process.argv.slice(2);
	const dryRun = flags.includes('--dry-run');
	const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL, NIGHTLY_JOB } =
		process.env;
	const job = NIGHTLY_JOB ?? 'e2e';
	const runUrl = `${GITHUB_SERVER_URL ?? 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
	const specs = failedSpecs(readReports(directory));

	if (specs.length === 0) {
		console.log(`no failing specs in ${directory}`);
		return;
	}
	if (dryRun) {
		for (const entry of plan(specs, new Map())) {
			console.log(`would file ${entry.title} -> ${runUrl}`);
		}
	} else {
		if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) {
			throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID are required');
		}
		const filed = await fileFailures(specs, {
			token: GITHUB_TOKEN,
			repository: GITHUB_REPOSITORY,
			job,
			runUrl
		});
		for (const { title, outcome } of filed) console.log(`${title}: ${outcome}`);
	}
	if (specs.length > MAX_ISSUES) {
		console.log(`${specs.length - MAX_ISSUES} more spec(s) not filed (cap ${MAX_ISSUES})`);
	}
}

// The spec imports the pure functions above, so only a direct run files anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main().catch((error) => {
		console.error(`could not file the nightly failures: ${error.message}`);
		process.exit(1);
	});
}
