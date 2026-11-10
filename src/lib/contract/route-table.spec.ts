import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

type Fixture = {
	steps: { request: { method: string; path: string }; response: { status: number } }[];
};

const routeTable = read('../../../contract/route-table.md');
const rustOnly = read('../../../contract/rust-only.md');
const fixtures = (
	JSON.parse(read('../../../contract/fixtures/scenarios.json')) as { scenarios: Fixture[] }
).scenarios;

const rows: { method: string; path: string; codes: number[] }[] = [];
for (const line of routeTable.split('\n')) {
	const match = /^\|\s*`([A-Z]+)\s+(\/api\/[^`]+)`/.exec(line);
	if (!match) continue;

	const tail = line.slice(match[0].length);
	rows.push({
		method: match[1],
		path: match[2],
		codes: [...new Set([...tail.matchAll(/\b(\d{3})\b/g)].map((code) => Number(code[1])))]
	});
}

/** A route-table path matches a scenario path, treating `[id]` as one wildcard segment. */
function matches(rowPath: string, actualPath: string): boolean {
	const expected = rowPath.split('/').filter(Boolean);
	const actual = actualPath.split('/').filter(Boolean);
	if (expected.length !== actual.length) return false;

	return expected.every((segment, index) => segment.startsWith('[') || segment === actual[index]);
}

/** Rows with no Node handler are documented as rust-only (contract/rust-only.md). */
function isRustOnly(method: string, rowPath: string): boolean {
	return rustOnly.includes(`${method} ${rowPath}`);
}

describe('route-table coverage', () => {
	it('parses the whole table', () => {
		expect(rows).toHaveLength(33);
	});

	it('has a scenario for every route-table row', () => {
		const missing = rows.filter((row) => {
			if (isRustOnly(row.method, row.path)) return false;

			return !fixtures.some((scenario) =>
				scenario.steps.some(
					(step) => step.request.method === row.method && matches(row.path, step.request.path)
				)
			);
		});

		expect(missing.map((row) => `${row.method} ${row.path}`)).toEqual([]);
	});

	it('has a scenario for every route-table status code', () => {
		const covered = new Set(
			fixtures.flatMap((scenario) => scenario.steps.map((step) => step.response.status))
		);
		const missing = [...new Set(rows.flatMap((row) => row.codes))].filter(
			(code) => !covered.has(code) && !(code === 501 && rustOnly.includes('501'))
		);

		expect(missing).toEqual([]);
	});
});
