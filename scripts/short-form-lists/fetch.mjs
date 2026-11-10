// Fetch pinned revisions of the bulk Short form sources (ADR 0046, ticket 05).
//
// Maintainer-run: `node scripts/short-form-lists/fetch.mjs --revision <name> [--out <dir>]`.
// Needs network access. Downloads each pinned source, keeps only the records the
// build reads, and writes them as filtered inputs plus a manifest with SHA-256
// hashes and source metadata. A rebuild from the saved inputs
// (`node scripts/short-form-lists/build.mjs`) is byte-identical. Refreshing a
// source means rerunning this script and committing the new inputs, which shows
// up as a reviewable diff.
//
// Pins: spec "Source pins (verified 2026-11-06)" and sources.md. ESCO is excluded
// by user decision (its licence requires an in-app credit line).

import { createGunzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const here = dirname(fileURLToPath(import.meta.url));

/** Pinned source revisions. Change these to refresh a source, then rerun this script. */
export const PINS = {
	onet: {
		database: '31.0',
		file: 'job_titles.json',
		url: 'https://www.onetcenter.org/dl_files/database/db_31_0_json/job_titles.json',
		license: 'CC BY 4.0'
	},
	kaikkiEn: {
		dump: '2026-10-01',
		wiktextract: '19f9a30',
		wikitextprocessor: '6f96ddf',
		url: 'https://kaikki.org/dictionary/English/words/enwiktionary-2026-10-01.jsonl.gz',
		license: 'CC BY-SA 4.0 (derived file)'
	},
	kaikkiEs: {
		dump: '2026-10-01',
		wiktextract: '19f9a30',
		wikitextprocessor: '6f96ddf',
		url: 'https://kaikki.org/dictionary/Spanish/words/eswiktionary-2026-10-01.jsonl.gz',
		license: 'CC BY-SA 4.0 (derived file)'
	},
	wikidata: {
		// Concept list the script defines; each item is fetched at a recorded
		// revision id so it can always be fetched again.
		items: [
			{ id: 'Q11661', label: 'information technology' },
			{ id: 'Q1470095', label: 'front of house' },
			{ id: 'Q5467169', label: 'human resources' }
		],
		license: 'CC0'
	}
};

/** Senses whose tags mark a short form (kept); everything else is skipped. */
export const SHORT_FORM_TAGS = new Set(['abbreviation', 'acronym', 'initialism']);

export function entityDataUrl(id, revision) {
	const base = `https://www.wikidata.org/wiki/Special:EntityData/${id}.json`;
	return revision === undefined ? base : `${base}?revision=${revision}`;
}

export function sha256Hex(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Filter O*NET job-title rows to the ones pair extraction reads: a parenthesised
 * short form in the title, or a distinct short title. Pure: tested in build.spec.ts.
 */
export function filterOnetRows(rows) {
	return rows.filter(
		(row) =>
			typeof row.job_title === 'string' &&
			(/\([^()]{1,8}\)/.test(row.job_title) ||
				(typeof row.short_title === 'string' &&
					row.short_title !== '' &&
					row.short_title !== row.job_title))
	);
}

/**
 * Whether a kaikki record is one the word-shortening extractor reads: English or
 * Spanish with a short-form sense carrying exactly one alt_of target.
 * Pure: tested in build.spec.ts.
 */
export function keepKaikkiRecord(record) {
	if (record.lang_code !== 'en' && record.lang_code !== 'es') return false;
	if (!Array.isArray(record.senses)) return false;
	return record.senses.some(
		(sense) =>
			Array.isArray(sense.tags) &&
			sense.tags.some((tag) => SHORT_FORM_TAGS.has(tag)) &&
			Array.isArray(sense.alt_of) &&
			sense.alt_of.length === 1 &&
			typeof sense.alt_of[0].word === 'string'
	);
}

/**
 * Filter one Wikidata entity to the concept the acronym extractor reads.
 * Pure: tested in build.spec.ts.
 */
export function filterWikidataEntity(id, entity) {
	const claims = entity.claims ?? {};
	const shortNames = (claims.P1813 ?? [])
		.map((claim) => claim?.mainsnak?.datavalue?.value?.text)
		.filter((text) => typeof text === 'string');
	return {
		id,
		revision: entity.lastrevid ?? null,
		label: entity.labels?.en?.value ?? entity.labels?.es?.value ?? '',
		aliases: {
			en: (entity.aliases?.en ?? []).map((alias) => alias.value),
			es: (entity.aliases?.es ?? []).map((alias) => alias.value)
		},
		p1813: {
			en: shortNames,
			es: []
		}
	};
}

async function fetchJson(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`fetch ${url} answered ${response.status}`);
	return response.json();
}

async function downloadGzJsonLines(url, keep, outPath) {
	const response = await fetch(url);
	if (!response.ok || response.body === null)
		throw new Error(`fetch ${url} answered ${response.status}`);
	const lines = Readable.fromWeb(response.body).pipe(createGunzip());
	let kept = 0;
	const out = createWriteStream(outPath);
	for await (const line of lines) {
		const text = line.toString().trim();
		if (text === '') continue;
		let record;
		try {
			record = JSON.parse(text);
		} catch {
			continue;
		}
		if (keep(record)) {
			out.write(`${JSON.stringify(record)}\n`);
			kept += 1;
		}
	}
	out.end();
	await new Promise((resolve) => out.on('finish', resolve));
	return kept;
}

async function main() {
	const args = process.argv.slice(2);
	const revisionFlag = args.indexOf('--revision');
	const revision = revisionFlag === -1 ? undefined : args[revisionFlag + 1];
	if (revision === undefined)
		throw new Error('--revision <name> names the snapshot this fetch feeds');
	const outFlag = args.indexOf('--out');
	const outDir = outFlag === -1 ? join(here, 'filtered-input') : args[outFlag + 1];
	if (outDir === undefined) throw new Error('--out needs a directory');
	await mkdir(outDir, { recursive: true });
	const files = [];
	const track = (path, source, pin, records) => {
		files.push({ path, source, pin, records });
	};

	const onetRows = await fetchJson(PINS.onet.url);
	const onetKept = filterOnetRows(onetRows);
	const onetPath = join(outDir, 'onet-job-titles.json');
	await writeFile(onetPath, `${JSON.stringify(onetKept, null, 1)}\n`);
	track(
		'onet-job-titles.json',
		'O*NET Job Titles',
		`Database ${PINS.onet.database}`,
		onetKept.length
	);

	for (const [name, pin, lang] of [
		['kaikki-en.jsonl', PINS.kaikkiEn, 'en'],
		['kaikki-es.jsonl', PINS.kaikkiEs, 'es']
	]) {
		const kept = await downloadGzJsonLines(pin.url, keepKaikkiRecord, join(outDir, name));
		track(
			name,
			`Wiktionary via kaikki.org (${lang})`,
			`dump ${pin.dump}, wiktextract ${pin.wiktextract}`,
			kept
		);
	}

	const entities = [];
	for (const item of PINS.wikidata.items) {
		const entity = await fetchJson(entityDataUrl(item.id));
		entities.push(filterWikidataEntity(item.id, entity.entities[item.id]));
	}
	const wikidataPath = join(outDir, 'wikidata.json');
	await writeFile(wikidataPath, `${JSON.stringify({ items: entities }, null, 1)}\n`);
	track(
		'wikidata.json',
		'Wikidata',
		'per-item revision ids recorded in each record',
		entities.length
	);

	const manifest = { revision, generatedBy: 'scripts/short-form-lists/fetch.mjs', files: [] };
	for (const file of files) {
		const text = await readFile(join(outDir, file.path), 'utf8');
		manifest.files.push({ ...file, sha256: sha256Hex(text) });
	}
	await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
	console.log(`wrote ${files.length} filtered inputs and manifest.json (revision ${revision})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
