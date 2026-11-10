import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/paraglide/runtime.js';
import type { Worker } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import { workerLabel } from './worker-label.ts';

const worker = (name: string, assessment: Worker['assessment']) =>
	baseWorker({ id: name, name, assessment });

afterEach(() => setLocale('en', { reload: false }));

describe('workerLabel', () => {
	it('keeps the worker name as entered and translates only the standing', () => {
		expect(workerLabel(worker('Ada Lovelace', 'Leader'))).toBe('Ada Lovelace — Leader');
		expect(workerLabel(worker('Ada Lovelace', 'Unassessed'))).toBe('Ada Lovelace — Unassessed');
	});

	it('uses the Spanish singular label for the standing', () => {
		setLocale('es-419', { reload: false });
		expect(workerLabel(worker('Ada Lovelace', 'Leader'))).toBe('Ada Lovelace — Líder');
		expect(workerLabel(worker('Ada Lovelace', 'Unassessed'))).toBe('Ada Lovelace — Sin evaluar');
	});
});
