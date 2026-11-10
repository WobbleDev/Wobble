import { describe, expect, it } from 'vitest';
import { defaultAppSettings } from '#lib/shared/app-settings.ts';
import {
	decodeAgitation,
	decodeConfigurationPreview,
	decodeShortFormSuggestions,
	decodeImportResult,
	decodeLanguage,
	decodeSettings,
	decodeWorker,
	decodeWorkerUpdate
} from './api-decode.ts';

describe('decoding an import result', () => {
	it('reads the count with each source row against its created id, in order', () => {
		expect(
			decodeImportResult({
				imported: 2,
				created: [
					{ row: 2, id: 'w1' },
					{ row: 5, id: 'w2' }
				]
			})
		).toEqual({
			imported: 2,
			created: [
				{ row: 2, id: 'w1' },
				{ row: 5, id: 'w2' }
			]
		});
	});

	it('refuses a reply whose ids do not match its count', () => {
		expect(() => decodeImportResult({ imported: 2, created: [{ row: 2, id: 'w1' }] })).toThrow();
		expect(() => decodeImportResult({ imported: 1 })).toThrow();
	});
});

describe('decoding an agitation result', () => {
	it('reads the id and text', () => {
		expect(decodeAgitation({ agitation: { id: 'a1', text: 'Closed on Sundays' } })).toEqual({
			id: 'a1',
			text: 'Closed on Sundays'
		});
	});
});

describe('decoding a language result', () => {
	it('reads the id and name', () => {
		expect(decodeLanguage({ language: { id: 'la1', name: 'Spanish' } })).toEqual({
			id: 'la1',
			name: 'Spanish'
		});
	});
});

describe('decoding a settings result', () => {
	it('reads every registered setting', () => {
		const settings = { ...defaultAppSettings, theme: 'dark', density: 'compact' } as const;
		expect(decodeSettings({ settings })).toEqual(settings);
	});

	it('refuses a body that is not valid settings', () => {
		const invalidSettings = 'Settings response was invalid.';
		expect(() => decodeSettings({})).toThrow(invalidSettings);
		expect(() => decodeSettings({ settings: { ...defaultAppSettings, theme: 'sepia' } })).toThrow(
			invalidSettings
		);
		expect(() => decodeSettings({ settings: { theme: 'dark' } })).toThrow(invalidSettings);
		expect(() =>
			decodeSettings({ settings: { ...defaultAppSettings, increaseContrast: 'true' } })
		).toThrow(invalidSettings);
		expect(() => decodeSettings(null)).toThrow(invalidSettings);
	});
});

describe('decoding a Worker', () => {
	const stored = {
		id: 'w1',
		name: 'Ada Lovelace',
		email: 'ada@example.test',
		phone: '555-0100',
		assessment: 'Leader',
		attributes: { a1: 'x', a2: ['y', 'z'] },
		agitations: ['g1'],
		languages: ['l1'],
		relationships: ['w2'],
		notes: [{ id: 'n1', text: 'Called', timestamp: '2026-01-01T00:00:00.000Z' }]
	};

	/** The stored record without the named keys, for the shapes that legitimately omit them. */
	function without(...keys: string[]): Record<string, unknown> {
		const copy: Record<string, unknown> = { ...stored };
		for (const key of keys) delete copy[key];
		return copy;
	}

	it('reads a stored record, keeping a valid editedAt', () => {
		expect(decodeWorker(stored)).toEqual(stored);
		const edited = {
			id: 'n1',
			text: 'Called',
			timestamp: 't',
			editedAt: '2026-02-01T00:00:00.000Z'
		};
		expect(decodeWorker({ ...stored, notes: [edited] }).notes).toEqual([edited]);
	});

	it('accepts an empty name, which a Worker may legitimately have', () => {
		const empty = { ...stored, name: '', email: '', phone: '', notes: [] };
		expect(decodeWorker(empty)).toEqual(empty);
	});

	it('accepts a draft body, which carries no identity', () => {
		const update = without('id');
		expect(decodeWorkerUpdate(update)).toEqual(update);
	});

	it('accepts what a draft check accepted: any assessment text, arrays of anything, any notes', () => {
		const loose = {
			...stored,
			assessment: 'Mystery',
			agitations: [1],
			languages: [null],
			relationships: [{}],
			notes: [{ text: 5 }]
		};
		const decoded = decodeWorker(loose);
		expect(decoded.assessment).toBe('Mystery');
		expect(decoded.agitations).toEqual([1]);
		expect(decoded.notes).toEqual([{ text: 5 }]);
	});
});

describe('decoding a Configuration preview select-mode section (ADR 0043)', () => {
	const preview = {
		base: 'base-1',
		changes: [],
		totals: { affectedWorkers: 0, lossyWorkers: 0, discardedValues: 0, affectedDrafts: 0 },
		removedAnswers: [],
		moves: []
	};
	const modeChange = {
		attributeId: 'dept',
		holders: [
			{
				workerId: 'ada',
				workerName: 'Ada',
				surface: 'value',
				held: ['packing', 'delivery'],
				kept: ['packing'],
				dropped: ['delivery']
			}
		]
	};

	it('decodes the modeChanges section', () => {
		expect(
			decodeConfigurationPreview({ ...preview, modeChanges: [modeChange] }).modeChanges
		).toEqual([modeChange]);
	});
});

describe('decoding the Configuration preview Short form suggestions (ADR 0046)', () => {
	const preview = {
		base: 'base-1',
		changes: [],
		totals: { affectedWorkers: 0, lossyWorkers: 0, discardedValues: 0, affectedDrafts: 0 },
		removedAnswers: [],
		moves: []
	};
	const suggestion = {
		attributeId: 'dept',
		answerId: 'a',
		shortForm: 'Cust. Svc.',
		shortFormOrigin: 'generated'
	};

	it('decodes the suggested forms', () => {
		expect(decodeConfigurationPreview({ ...preview, shortForms: [suggestion] }).shortForms).toEqual(
			[suggestion]
		);
	});
});

describe('decoding Short form suggestions (ADR 0046)', () => {
	const suggestion = {
		attributeId: 'dept',
		answerId: 'a',
		shortForm: 'Cust. Svc.',
		shortFormOrigin: 'generated'
	};

	it('decodes the listed forms', () => {
		expect(decodeShortFormSuggestions({ shortForms: [suggestion] })).toEqual([suggestion]);
	});
});
