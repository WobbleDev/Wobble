import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseRecordingFile } from '../src/lib/client/replay.ts';
import type { ApiRecording, RecordingFile } from '../src/lib/client/replay.ts';

/** `e2e/recordings/<spec basename>/<test title slug>.json` for one test. */
export function recordingPath(specFile: string, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 120);
	return join(
		import.meta.dirname,
		'recordings',
		basename(specFile).replace(/\.spec\.ts$/, ''),
		`${slug}.json`
	);
}

export function readRecordings(file: string): RecordingFile {
	return parseRecordingFile(JSON.parse(readFileSync(file, 'utf8')));
}

export function writeRecordings(file: string, recordings: RecordingFile): void {
	const pages = [...recordings.pages].sort((a: ApiRecording, b: ApiRecording) =>
		`${a.path}?${a.query ?? ''} ${a.method}`.localeCompare(`${b.path}?${b.query ?? ''} ${b.method}`)
	);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ ...recordings, pages }, null, '\t') + '\n');
}
