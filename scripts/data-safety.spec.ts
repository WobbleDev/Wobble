// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(__dirname, 'data-safety.sh');
// Built at run time so no address literal sits in the source.
const foreign = ['worker07', 'sample-corp.io'].join('@');
const synthetic = ['worker08', 'example.com'].join('@');
// GitHub's own address, which every squash-merged commit carries as its committer.
const githubNoreply = ['noreply', 'github.com'].join('@');
const githubPerson = ['worker09', 'github.com'].join('@');

const run = (...args: string[]) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });

const reportDir = (report: unknown) => {
	const dir = mkdtempSync(join(tmpdir(), 'data-safety-'));
	writeFileSync(join(dir, 'results.json'), JSON.stringify(report));
	return dir;
};

describe('data-safety.sh redact', () => {
	const report = {
		tests: [
			{ results: [{ stdout: [`hello ${foreign} and ${synthetic}`], error: { message: 'boom' } }] }
		]
	};

	it('names the key path and count, never the address, and leaves a report the scan accepts', () => {
		const dir = reportDir(report);
		expect(run('emails', dir).status).toBe(1);

		const redact = run('redact', dir);
		expect(redact.status).toBe(0);
		expect(redact.stdout).toContain('tests.[].results.[].stdout.[]: 1');
		expect(redact.stdout).not.toContain(foreign);

		const kept = readFileSync(join(dir, 'results.json'), 'utf8');
		expect(kept).not.toContain(foreign);
		expect(kept).toContain(synthetic);
		expect(kept).toContain('boom');
		expect(run('emails', dir).status).toBe(0);
	});

	it('leaves a clean report untouched', () => {
		const dir = reportDir({ tests: [{ results: [{ stdout: [synthetic] }] }] });
		const before = readFileSync(join(dir, 'results.json'), 'utf8');
		expect(run('redact', dir).stdout).toContain('0 address(es) redacted');
		expect(readFileSync(join(dir, 'results.json'), 'utf8')).toBe(before);
	});
});

describe("data-safety.sh and GitHub's own address", () => {
	it('lets exactly the GitHub noreply address through, in the scan and in redact', () => {
		const dir = reportDir({ metadata: { committer: githubNoreply } });
		expect(run('emails', dir).status).toBe(0);
		expect(run('redact', dir).stdout).toContain('0 address(es) redacted');
	});

	it('still flags any other address at github.com', () => {
		const dir = reportDir({ metadata: { committer: githubPerson } });
		expect(run('emails', dir).status).toBe(1);
		const redact = run('redact', dir);
		expect(redact.stdout).toContain('metadata.committer: 1');
		expect(redact.stdout).not.toContain(githubPerson);
	});
});
