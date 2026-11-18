// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	MAX_ISSUES,
	failedSpecs,
	fileFailures,
	issueTitle,
	plan,
	readReports
} from './nightly-flake-issues.mjs';

type Spec = {
	file?: string;
	ok?: boolean;
	tests?: { status?: string }[];
};
type Suite = { file?: string; specs?: Spec[]; suites?: Suite[] };

const report = (...suites: Suite[]) => ({ suites });

const RUN = 'https://github.com/WobbleDev/wobble/actions/runs/1';

describe('the nightly flake filer', () => {
	it('takes only the specs whose tests failed after their retries', () => {
		const specs = failedSpecs([
			report({
				specs: [
					{ file: 'e2e/b-failed.spec.ts', ok: false },
					{
						file: 'e2e/c-unexpected.spec.ts',
						ok: true,
						tests: [{ status: 'unexpected' }]
					},
					{ file: 'e2e/a-passed.spec.ts', ok: true, tests: [{ status: 'expected' }] },
					{ file: 'e2e/d-flaky.spec.ts', ok: true, tests: [{ status: 'flaky' }] }
				]
			})
		]);
		expect(specs).toEqual(['e2e/b-failed.spec.ts', 'e2e/c-unexpected.spec.ts']);
	});

	it('reads nested suites and takes the file from the parent when the spec has none', () => {
		const specs = failedSpecs([
			report({
				file: 'e2e/nested.spec.ts',
				suites: [{ suites: [{ specs: [{ ok: false }] }] }]
			})
		]);
		expect(specs).toEqual(['e2e/nested.spec.ts']);
	});

	it('never publishes a report field that is not a spec path', () => {
		const specs = failedSpecs([
			report({
				specs: [
					{ file: 'https://example.test/leak.spec.ts', ok: false },
					{ file: '../../etc/passwd', ok: false },
					{ file: 'e2e/real.spec.ts', ok: false }
				]
			})
		]);
		expect(specs).toEqual(['e2e/real.spec.ts']);
	});

	it('comments on the open issue for a spec that already has one', () => {
		const entries = plan(
			['e2e/one.spec.ts', 'e2e/two.spec.ts'],
			new Map([[issueTitle('e2e/two.spec.ts'), 42]])
		);
		expect(entries).toEqual([
			{ spec: 'e2e/one.spec.ts', title: issueTitle('e2e/one.spec.ts'), issue: null },
			{ spec: 'e2e/two.spec.ts', title: issueTitle('e2e/two.spec.ts'), issue: 42 }
		]);
	});

	it('files at most the cap, so a run where everything failed cannot mass-file', () => {
		const specs = Array.from({ length: MAX_ISSUES + 3 }, (_, index) => `e2e/s${index}.spec.ts`);
		expect(plan(specs, new Map())).toHaveLength(MAX_ISSUES);
	});

	it('files a spec and the run link only, and comments on the issue it already filed', async () => {
		type Call = { url: string; method: string; body?: Record<string, unknown> };
		const calls: Call[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL, init?: { method?: string; body?: string }) => {
			const call: Call = {
				url: String(url),
				method: init?.method ?? 'GET',
				body: init?.body ? JSON.parse(init.body) : undefined
			};
			calls.push(call);
			if (call.url.includes('/search/issues')) {
				const items = [{ number: 42, title: issueTitle('e2e/seen.spec.ts') }];
				return new Response(JSON.stringify({ items }), { status: 200 });
			}
			return new Response(JSON.stringify({ number: 7 }), { status: 201 });
		}) as typeof fetch;
		try {
			const filed = await fileFailures(['e2e/new.spec.ts', 'e2e/seen.spec.ts'], {
				token: 'token',
				repository: 'WobbleDev/wobble',
				job: 'chromium',
				runUrl: RUN
			});
			expect(filed).toEqual([
				{ title: issueTitle('e2e/new.spec.ts'), outcome: 'opened #7' },
				{ title: issueTitle('e2e/seen.spec.ts'), outcome: 'commented on #42' }
			]);
			const created = calls.find((call) => call.method === 'POST' && call.url.endsWith('/issues'))!;
			expect(created.body).toEqual({
				title: issueTitle('e2e/new.spec.ts'),
				labels: ['nightly-flake'],
				body: expect.stringContaining(RUN)
			});
			expect(created.body!.body).toContain('e2e/new.spec.ts');
			const comment = calls.find((call) => call.url.endsWith('/issues/42/comments'))!;
			expect(comment.body!.body).toContain('The **chromium** job failed in');
			expect(comment.body!.body).toContain('e2e/seen.spec.ts');
			expect(comment.body!.body).toContain(RUN);
		} finally {
			globalThis.fetch = original;
		}
	});

	it('reads every JSON report in the directory and skips the unreadable one', () => {
		const directory = mkdtempSync(join(tmpdir(), 'wobble-nightly-flake-'));
		writeFileSync(
			join(directory, 'regular.json'),
			JSON.stringify(report({ specs: [{ file: 'e2e/kept.spec.ts', ok: false }] }))
		);
		writeFileSync(join(directory, 'broken.json'), '{not json');
		writeFileSync(join(directory, 'notes.txt'), 'ignored');
		expect(failedSpecs(readReports(directory))).toEqual(['e2e/kept.spec.ts']);
		expect(readReports(join(directory, 'missing'))).toEqual([]);
	});
});
