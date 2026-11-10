import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConfigurationPreview, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { fromWorkerAttributeDefinitions } from './attribute-draft.ts';
import {
	buildResolutionGroups,
	holderKey,
	resolutionsFromPreview,
	type PreviewHolderChoices
} from './configuration-preview.ts';
import { fieldExampleOptions } from './field-example.ts';
import { workerImpact } from './worker-impact.ts';

const department: WorkerAttributeDefinition = {
	id: 'dept',
	name: 'Department',
	kind: 'category',
	answers: [
		{ id: 'packing', value: 'Packing' },
		{ id: 'delivery', value: 'Delivery' }
	]
};

const preview = {
	base: 'b',
	changes: [],
	totals: { affectedWorkers: 2, lossyWorkers: 2, discardedValues: 0, affectedDrafts: 0 },
	removedAnswers: [
		{
			attributeId: 'dept',
			answerId: 'packing',
			affectedWorkers: 2,
			holders: ['w1', 'w2'].map((workerId, i) => ({
				workerId,
				workerName: i === 0 ? 'Ada' : 'Bea',
				kind: 'worker',
				emptyIfUnanswered: true,
				value: 'packing',
				replacements: [{ answerId: 'delivery', resultingValue: 'delivery' }]
			}))
		}
	],
	removedAttributes: [],
	cardinality: [],
	moves: [],
	attributeMoves: [],
	modeChanges: [],
	shortForms: []
} as unknown as ConfigurationPreview;

const draft = fromWorkerAttributeDefinitions([{ ...department, answers: [department.answers[1]] }]);
const key = (worker: string) => holderKey('dept', 'packing', worker, 'worker');

function groups(choices: PreviewHolderChoices) {
	return buildResolutionGroups(preview, [department], draft, choices);
}

describe('worker impact', () => {
	it('names unresolved, removed and retained values per Worker', () => {
		const rows = workerImpact(
			groups({ [key('w1')]: { replacement: 'delivery' }, [key('w2')]: { replacement: null } })
		);
		expect(rows.map((w) => [w.workerName, w.rows[0].state])).toEqual([
			['Ada', 'retained'],
			['Bea', 'removed']
		]);
		expect(rows[0].rows[0]).toMatchObject({ before: 'Department: Packing', after: 'Delivery' });
		expect(workerImpact(groups({}))[0].rows[0].state).toBe('unresolved');
	});

	it('agrees with the resolutions a save sends', () => {
		const choices: PreviewHolderChoices = {
			[key('w1')]: { replacement: 'delivery' },
			[key('w2')]: { replacement: null }
		};
		const built = groups(choices);
		const saved = resolutionsFromPreview(preview, built).removedAnswers[0].holders;
		for (const worker of workerImpact(built)) {
			const sent = saved.find((holder) => holder.workerId === worker.workerId);
			const row = worker.rows[0];
			expect(row.state === 'retained').toBe(sent?.replacement !== undefined);
			if (sent?.replacement) expect(row.after).toBe('Delivery');
		}
	});

	it('builds rows only from planner-reply groups', () => {
		const source = readFileSync(new URL('./worker-impact.ts', import.meta.url), 'utf8');
		expect(source).toContain('groups: readonly PreviewResolutionGroup[]');
		expect(source).toContain('(row: PreviewHolderRow)');
		expect(source).not.toMatch(
			/draftAttributes|draftAgitations|draftLanguages|saved(Configuration|Agitations|Languages)/
		);
		const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
		expect(imports).toEqual(['#lib/paraglide/messages.js', './configuration-preview.ts']);
	});
});

describe('field example', () => {
	const forbidden = [
		'updateWorkerField',
		'updateWorkerAttribute',
		'updateWorkerLanguages',
		'createWorker',
		'workers-api'
	];

	function closure(entry: string, seen = new Set<string>()): Set<string> {
		const path = new URL(entry, import.meta.url);
		if (seen.has(path.pathname)) return seen;
		seen.add(path.pathname);
		const source = readFileSync(path, 'utf8');
		for (const [, spec] of source.matchAll(/from '(\.[^']+)'/g)) {
			closure(new URL(spec, path).pathname, seen);
		}
		return seen;
	}

	it('has no worker writer in its dependency closure', () => {
		const files = closure('./field-example.svelte');
		files.add(new URL('./field-example.ts', import.meta.url).pathname);
		for (const file of closure('./field-example.ts')) files.add(file);
		for (const file of files) {
			const source = readFileSync(file, 'utf8');
			for (const word of forbidden) expect(source, `${file} ${word}`).not.toContain(word);
		}
	});

	it('takes no write callback props', () => {
		const source = readFileSync(new URL('./field-example.svelte', import.meta.url), 'utf8');
		const props = source.match(/type Props = \{([^}]*)\}/)?.[1] ?? '';
		expect(props).not.toMatch(/=>|\bon[A-Z]/);
	});

	it('offers the draft leaf answers', () => {
		expect(fieldExampleOptions(department).map((option) => option.label)).toEqual([
			'Packing',
			'Delivery'
		]);
	});
});
