// Tests for the Short form list pipeline (ticket 05). No network access: the gates
// and extractors run on inline records, and the end-to-end build runs on the
// committed fixture inputs in filtered-input/.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	build,
	extractKaikkiPairs,
	extractOnetPairs,
	extractWikidataPairs,
	renderNotice,
	renderSnapshot,
	splitDuplicates,
	splitGroups
} from './build.mjs';
import { applyGates, gatePair } from './gates.mjs';

describe('gatePair', () => {
	it('keeps a shorter same-first-letter in-order pair', () => {
		expect(gatePair('dept.', 'department')).toEqual({ ok: true });
		expect(gatePair('PR', 'Public Relations')).toEqual({ ok: true });
		expect(gatePair('admón.', 'administración')).toEqual({ ok: true });
	});
	it('drops pairs that fail each gate, naming the reason', () => {
		expect(gatePair('', 'department')).toEqual({ ok: false, reason: 'empty' });
		expect(gatePair('department', 'dept')).toEqual({ ok: false, reason: 'not-shorter' });
		expect(gatePair('dept', 'dept')).toEqual({ ok: false, reason: 'not-shorter' });
		expect(gatePair('XX', 'Customer Service')).toEqual({ ok: false, reason: 'first-letter' });
		expect(gatePair('Sse', 'Services')).toEqual({ ok: false, reason: 'letter-order' });
		expect(gatePair('xyz', 'servicio')).toEqual({ ok: false, reason: 'first-letter' });
	});

	it('ignores punctuation in the short form but keeps accents significant', () => {
		expect(gatePair('n.', 'north')).toEqual({ ok: true });
		expect(gatePair('admón.', 'administracion')).toEqual({ ok: false, reason: 'letter-order' });
	});
});

describe('applyGates', () => {
	it('keeps every expansion of an ambiguous short form', () => {
		const { kept, dropped } = applyGates([
			{
				short: 'PR',
				expansion: 'Public Relations',
				list: 'acronyms',
				language: 'en',
				source: 'onet'
			},
			{ short: 'PR', expansion: 'Payroll', list: 'acronyms', language: 'en', source: 'onet' },
			{ short: 'PR', expansion: 'Clerk', list: 'acronyms', language: 'en', source: 'onet' }
		]);
		expect(kept.map((pair) => pair.expansion).sort()).toEqual(['Payroll', 'Public Relations']);
		expect(dropped).toEqual([
			{
				short: 'PR',
				expansion: 'Clerk',
				list: 'acronyms',
				language: 'en',
				source: 'onet',
				reason: 'first-letter'
			}
		]);
	});
});
describe('extractors', () => {
	it('reads Schwartz-Hearst pairs from O*NET titles', () => {
		expect(extractOnetPairs({ job_title: 'Public Relations (PR) Specialist' })).toEqual([
			{
				expansion: 'Public Relations',
				short: 'PR',
				list: 'acronyms',
				language: 'en',
				source: 'onet'
			},
			{ expansion: 'Specialist', short: 'PR', list: 'acronyms', language: 'en', source: 'onet' }
		]);
		expect(extractOnetPairs({ job_title: 'Payroll Clerk' })).toEqual([]);
		expect(extractOnetPairs({})).toEqual([]);
	});

	it('reads one-target abbreviation senses and splits acronym tags from words', () => {
		const abbreviation = {
			word: 'dept.',
			lang_code: 'en',
			senses: [{ tags: ['abbreviation'], alt_of: [{ word: 'department' }] }]
		};
		expect(extractKaikkiPairs(abbreviation)).toEqual([
			{ expansion: 'department', short: 'dept.', list: 'words', language: 'en', source: 'kaikki' }
		]);
		const acronym = {
			word: 'HR',
			lang_code: 'en',
			senses: [{ tags: ['acronym'], alt_of: [{ word: 'Human Resources' }] }]
		};
		expect(extractKaikkiPairs(acronym)).toEqual([
			{
				expansion: 'Human Resources',
				short: 'HR',
				list: 'acronyms',
				language: 'en',
				source: 'kaikki'
			}
		]);
		const ambiguous = {
			word: 'dept.',
			lang_code: 'en',
			senses: [{ tags: ['abbreviation'], alt_of: [{ word: 'department' }, { word: 'deputy' }] }]
		};
		expect(extractKaikkiPairs(ambiguous)).toEqual([]);
		const french = {
			word: 'rue',
			lang_code: 'fr',
			senses: [{ tags: ['abbreviation'], alt_of: [{ word: 'rue' }] }]
		};
		expect(extractKaikkiPairs(french)).toEqual([]);
	});

	it('reads short-form-shaped Wikidata aliases and P1813 names per language', () => {
		const pairs = extractWikidataPairs({
			label: { en: 'information technology' },
			aliases: { en: ['IT', 'TI', 'Shelf:Information technology'], es: [] },
			p1813: { en: ['IT'], es: [] }
		});
		expect(pairs).toContainEqual({
			expansion: 'information technology',
			short: 'IT',
			list: 'acronyms',
			language: 'en',
			source: 'wikidata'
		});
		expect(pairs.some((pair) => pair.short === 'TI')).toBe(true);
		expect(pairs.some((pair) => pair.short.startsWith('Shelf'))).toBe(false);
		const gated = applyGates(pairs);
		expect(gated.kept.some((pair) => pair.short === 'TI')).toBe(false);
		expect(gated.dropped.filter((pair) => pair.short === 'TI')).toEqual([
			{
				expansion: 'information technology',
				short: 'TI',
				list: 'acronyms',
				language: 'en',
				source: 'wikidata',
				reason: 'first-letter'
			}
		]);
		expect(extractWikidataPairs({ label: {}, aliases: {}, p1813: {} })).toEqual([]);
	});
});
describe('splitGroups and splitDuplicates', () => {
	it('groups pairs by language and list, sorted, collapsing exact duplicates', () => {
		const kept = [
			{ short: 'PR', expansion: 'Payroll', list: 'acronyms', language: 'en', source: 'onet' },
			{
				short: 'PR',
				expansion: 'Public Relations',
				list: 'acronyms',
				language: 'en',
				source: 'onet'
			},
			{ short: 'dept.', expansion: 'department', list: 'words', language: 'en', source: 'kaikki' },
			{
				short: 'depto.',
				expansion: 'departamento',
				list: 'words',
				language: 'es',
				source: 'kaikki'
			}
		];
		const { unique, duplicates } = splitDuplicates(kept);
		expect(duplicates).toBe(0);
		expect(unique).toHaveLength(4);
		// The same pair from a second source collapses instead of appearing twice.
		const twice = [...kept, { ...kept[0], source: 'wikidata' }];
		const deduped = splitDuplicates(twice);
		expect(deduped.duplicates).toBe(1);
		expect(deduped.unique).toHaveLength(4);
		const groups = splitGroups(deduped.unique);
		expect(groups.en.acronyms).toEqual([
			['Payroll', 'PR'],
			['Public Relations', 'PR']
		]);
		expect(groups.en.words).toEqual([['department', 'dept.']]);
		expect(groups.es.words).toEqual([['departamento', 'depto.']]);
		expect(groups.es.acronyms).toEqual([]);
	});

	it('renders the snapshot and notice from grouped pairs', () => {
		const groups = {
			en: { words: [['department', 'dept.']], acronyms: [['payroll', 'PR']] },
			es: { words: [], acronyms: [] }
		};
		const snapshot = renderSnapshot('rev-1', groups, 'Test note.');
		expect(snapshot).toContain('pub const REVISION: &str = "rev-1";');
		expect(snapshot).toContain('("department", "dept.")');
		expect(snapshot).toContain('("payroll", "PR")');
		const notice = renderNotice('rev-1', 2, 1);
		expect(notice).toContain('revision rev-1');
		expect(notice).toContain('O*NET');
		expect(notice).toContain('Wikidata');
	});
});

describe('fixture build', () => {
	const inputDir = 'scripts/short-form-lists/filtered-input';
	const runBuild = () => {
		const dir = mkdtempSync(join(tmpdir(), 'short-forms-'));
		const paths = {
			snapshotPath: join(dir, 'snapshot.rs'),
			reportPath: join(dir, 'report.json'),
			noticePath: join(dir, 'NOTICE')
		};
		return build({ inputDir, ...paths }).then((summary) => ({ summary, paths }));
	};

	it('produces the seeded pairs plus the sourced IT acronym', async () => {
		const { summary, paths } = await runBuild();
		expect(summary).toEqual({ kept: 32, dropped: 11 });
		const snapshot = readFileSync(paths.snapshotPath, 'utf8');
		expect(snapshot).toContain('("department", "dept.")');
		expect(snapshot).toContain('("public relations", "PR")');
		expect(snapshot).toContain('("payroll", "PR")');
		expect(snapshot).toContain('("information technology", "IT")');
		expect(snapshot).toContain('("departamento", "depto.")');
		expect(snapshot).toContain('pub const REVISION: &str = "sf05-fixture-1";');
		expect(snapshot).not.toContain('"TI"');
	});

	it('reports drop counts with reasons and splits kept pairs by language', async () => {
		const { paths } = await runBuild();
		const report = JSON.parse(readFileSync(paths.reportPath, 'utf8'));
		expect(report.revision).toBe('sf05-fixture-1');
		expect(report.kept).toEqual({ en: { words: 21, acronyms: 4 }, es: { words: 7, acronyms: 0 } });
		expect(report.droppedTotal).toBe(report.dropped.length);
		const reasons = new Set(report.dropped.map((pair) => pair.reason));
		expect([...reasons].sort()).toEqual(['first-letter', 'not-shorter']);
		expect(
			report.dropped.some((pair) => pair.short === 'department' && pair.reason === 'not-shorter')
		).toBe(true);
		expect(report.dropped.filter((pair) => pair.language === 'es')).toHaveLength(1);
	});

	it('writes a NOTICE crediting every source with its license', async () => {
		const { paths } = await runBuild();
		const notice = readFileSync(paths.noticePath, 'utf8');
		expect(notice).toContain('O*NET');
		expect(notice).toContain('CC BY 4.0');
		expect(notice).toContain('kaikki');
		expect(notice).toContain('CC BY-SA 4.0');
		expect(notice).toContain('Wikidata');
		expect(notice).toContain('CC0');
		expect(notice).toContain('sf05-fixture-1');
	});

	it('rebuilds byte-identically from the same inputs', async () => {
		const first = await runBuild();
		const second = await runBuild();
		for (const key of ['snapshotPath', 'reportPath', 'noticePath'] as const) {
			expect(readFileSync(second.paths[key], 'utf8')).toBe(readFileSync(first.paths[key], 'utf8'));
		}
	});

	it('refuses inputs whose checksum changed', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'short-forms-'));
		const { copyFileSync, writeFileSync, mkdirSync } = await import('node:fs');
		mkdirSync(join(dir, 'in'));
		copyFileSync(join(inputDir, 'manifest.json'), join(dir, 'in', 'manifest.json'));
		copyFileSync(
			join(inputDir, 'onet-job-titles.fixture.json'),
			join(dir, 'in', 'onet-job-titles.fixture.json')
		);
		writeFileSync(join(dir, 'in', 'onet-job-titles.fixture.json'), '[]\n');
		await expect(
			build({
				inputDir: join(dir, 'in'),
				snapshotPath: join(dir, 's.rs'),
				reportPath: join(dir, 'r.json'),
				noticePath: join(dir, 'NOTICE')
			})
		).rejects.toThrow(/checksum mismatch/);
	});
});
