import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decoderFor } from './decoders.ts';

type Step = {
	request: { method: string; path: string; body: unknown };
	response: { status: number; body: unknown };
};
type Scenario = { name: string; steps: Step[] };

const scenarios = (
	JSON.parse(
		readFileSync(new URL('../../../contract/fixtures/scenarios.json', import.meta.url), 'utf8')
	) as { scenarios: Scenario[] }
).scenarios;

describe('scenario decode', () => {
	for (const scenario of scenarios) {
		it(scenario.name, () => {
			const failures: string[] = [];
			for (const step of scenario.steps) {
				const { status, body } = step.response;
				if (status < 200 || status > 299) continue;

				const decoder = decoderFor(step.request.method, step.request.path);
				if (decoder === undefined) continue;

				try {
					decoder(body, step.request.body);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					failures.push(`${step.request.method} ${step.request.path} (${status}): ${message}`);
				}
			}

			expect(failures).toEqual([]);
		});
	}
});
