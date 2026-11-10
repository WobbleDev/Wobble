import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRecordingFile } from '#lib/client/replay.ts';
import { decoderFor } from './decoders.ts';

const root = new URL('../../../e2e/recordings/', import.meta.url).pathname;

const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
	.filter((file) => file.endsWith('.json'))
	.sort();

/** A recording the client can no longer decode is stale: re-record it (docs/agents/testing.md). */
describe('e2e recordings', () => {
	for (const file of files) {
		it(`${file} decodes with the client's decoders`, () => {
			const { pages, seed = [] } = parseRecordingFile(
				JSON.parse(readFileSync(join(root, file), 'utf8'))
			);
			const recordings = [
				...pages.map((entry) => ({ ...entry, seeded: false })),
				...seed.map((entry) => ({ ...entry, path: entry.path.split('?')[0], seeded: true }))
			];
			const failures: string[] = [];
			for (const { method, path, status, body, seeded } of recordings) {
				if (status < 200 || status > 299) continue;
				const decoder = decoderFor(method, path);
				if (decoder === undefined) {
					if (seeded) continue;
					failures.push(`${method} ${path}: no decoder`);
					continue;
				}
				try {
					decoder(body, undefined);
				} catch (error) {
					failures.push(`${method} ${path}: ${error instanceof Error ? error.message : error}`);
				}
			}
			expect(failures).toEqual([]);
		});
	}

	it('has recordings', () => {
		expect(files.length).toBeGreaterThan(0);
	});
});
