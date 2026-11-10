import { describe, expect, it } from 'vitest';
import type { AttributeAnswer, Worker, WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import { worker as baseWorker } from '#lib/testing/builders.ts';
import {
	answerIsInSubtree,
	countAnswerPopulation,
	countValueHolders,
	heldAnswerIds,
	selectWorkerPopulation
} from './worker-population.ts';

function answer(id: string, value: string, parentId?: string): AttributeAnswer {
	return { id, value, ...(parentId ? { parentId } : {}) };
}

const department: WorkerAttributeDefinition = {
	id: 'dept',
	name: 'Department',
	kind: 'category',
	answers: [
		answer('store', 'Store'),
		answer('store-a', 'Store A', 'store'),
		answer('store-a-cashier', 'Cashier', 'store-a'),
		answer('store-b', 'Store B', 'store'),
		answer('warehouse', 'Warehouse')
	]
};

const roles: WorkerAttributeDefinition = {
	id: 'roles',
	name: 'Roles',
	kind: 'tag',
	answers: [
		answer('trainer', 'Trainer'),
		answer('senior-trainer', 'Senior Trainer', 'trainer'),
		answer('steward', 'Steward')
	]
};

const attributes = [department, roles];

const worker = (id: string, attributeValues: Record<string, string | string[]>) =>
	baseWorker({ id, name: id, attributes: attributeValues });

function ids(workers: readonly Worker[]): string[] {
	return workers.map((entry) => entry.id);
}

describe('heldAnswerIds', () => {
	it("reads a Single-Select Worker's one id and treats a blank as none", () => {
		expect(heldAnswerIds(worker('a', { dept: 'store-a' }), department)).toEqual(['store-a']);
		expect(heldAnswerIds(worker('a', { dept: '' }), department)).toEqual([]);
		expect(heldAnswerIds(worker('a', {}), department)).toEqual([]);
	});

	it("reads a Multi-Select Worker's ids in recorded order", () => {
		expect(heldAnswerIds(worker('a', { roles: ['steward', 'trainer'] }), roles)).toEqual([
			'steward',
			'trainer'
		]);
		expect(heldAnswerIds(worker('a', { roles: [] }), roles)).toEqual([]);
	});

	it('refuses a value of the wrong shape instead of coercing it', () => {
		expect(heldAnswerIds(worker('a', { dept: ['store-a'] }), department)).toEqual([]);
		expect(heldAnswerIds(worker('a', { roles: 'trainer' }), roles)).toEqual([]);
	});
});

describe('answerIsInSubtree', () => {
	it('includes the selected answer and every descendant', () => {
		expect(answerIsInSubtree(department.answers, 'store', 'store-a-cashier')).toBe(true);
		expect(answerIsInSubtree(department.answers, 'store', 'warehouse')).toBe(false);
	});

	it('selects nothing for an id the Attribute no longer offers', () => {
		expect(answerIsInSubtree(department.answers, 'ghost', 'ghost')).toBe(false);
	});
});

describe('selectWorkerPopulation', () => {
	const ada = worker('ada', { dept: 'store-a-cashier', roles: ['trainer', 'steward'] });
	const bea = worker('bea', { dept: 'store-b', roles: [] });
	const cy = worker('cy', { dept: '', roles: [] });

	it('selects every Worker when no condition is active', () => {
		expect(ids(selectWorkerPopulation([ada, bea, cy], attributes).workers)).toEqual([
			'ada',
			'bea',
			'cy'
		]);
		expect(selectWorkerPopulation([ada], attributes)).toEqual({ workers: [ada] });
	});

	it('ORs several selected answers within one Attribute', () => {
		const population = selectWorkerPopulation([ada, bea, cy], attributes, {
			answers: new Map([['dept', ['store-a', 'warehouse']]])
		});

		expect(ids(population.workers)).toEqual(['ada']);
	});

	it('includes descendants for an ordinary parent selection', () => {
		const population = selectWorkerPopulation([ada, bea, cy], attributes, {
			answers: new Map([['dept', ['store']]])
		});

		expect(ids(population.workers)).toEqual(['ada', 'bea']);
	});

	it('matches only the held answer itself for an exact remainder', () => {
		const population = selectWorkerPopulation([ada, bea, cy], attributes, {
			exactAnswers: new Map([['dept', ['store-a']]])
		});

		expect(ids(population.workers)).toEqual([]);

		const parentHolder = worker('dee', { dept: 'store-a' });
		expect(
			ids(
				selectWorkerPopulation([ada, parentHolder], attributes, {
					exactAnswers: new Map([['dept', ['store-a']]])
				}).workers
			)
		).toEqual(['dee']);
	});

	it('counts a Worker once even when several selected descendants share an ancestor', () => {
		const population = selectWorkerPopulation([ada, bea, cy], attributes, {
			answers: new Map([['dept', ['store-a', 'store-a-cashier', 'store']]])
		});

		expect(ids(population.workers)).toEqual(['ada', 'bea']);
	});

	it('reads the no-answer condition for either cardinality', () => {
		const population = selectWorkerPopulation([ada, bea, cy], attributes, {
			missing: new Set(['dept', 'roles'])
		});

		// A Worker must satisfy every Attribute's no-answer reading to match.
		expect(ids(population.workers)).toEqual(['cy']);
		expect(
			ids(
				selectWorkerPopulation([ada, bea, cy], attributes, {
					missing: new Set(['roles'])
				}).workers
			)
		).toEqual(['bea', 'cy']);
	});

	it('ORs a selected answer with the no-answer reading inside one Attribute', () => {
		const population = selectWorkerPopulation([ada, bea, cy], attributes, {
			answers: new Map([['dept', ['warehouse']]]),
			missing: new Set(['dept'])
		});

		expect(ids(population.workers)).toEqual(['cy']);
	});

	it('ignores an Attribute the Worksite no longer configures and an empty answer list', () => {
		expect(
			ids(
				selectWorkerPopulation([ada, bea, cy], attributes, {
					answers: new Map([['ghost', ['x']]]),
					missing: new Set(['ghost']),
					exactAnswers: new Map([['ghost', ['x']]])
				}).workers
			)
		).toEqual(['ada', 'bea', 'cy']);
		expect(
			ids(
				selectWorkerPopulation([ada, bea, cy], attributes, {
					answers: new Map([['dept', []]])
				}).workers
			)
		).toEqual(['ada', 'bea', 'cy']);
	});
});

describe('canonical Ada/Bea/Cy independent Attribute readings', () => {
	// The specification's conversion result: Store and Job are Multi-Select, Shift is
	// Single-Select. Ada holds both stores and both jobs, Bea holds Store A and
	// Cashier, and Cy holds nothing.
	const store: WorkerAttributeDefinition = {
		id: 'store',
		name: 'Store',
		kind: 'tag',
		answers: [answer('store-a', 'Store A'), answer('store-b', 'Store B')]
	};
	const job: WorkerAttributeDefinition = {
		id: 'job',
		name: 'Job',
		kind: 'tag',
		answers: [answer('cashier', 'Cashier'), answer('stocker', 'Stocker')]
	};
	const shift: WorkerAttributeDefinition = {
		id: 'shift',
		name: 'Shift',
		kind: 'category',
		answers: [answer('days', 'Days'), answer('nights', 'Nights')]
	};
	const canonical = [store, job, shift];
	const canonicalWorkers = [
		worker('ada', { store: ['store-a', 'store-b'], job: ['cashier', 'stocker'], shift: 'days' }),
		worker('bea', { store: ['store-a'], job: ['cashier'], shift: 'nights' }),
		worker('cy', { store: [], job: [], shift: '' })
	];

	it('matches Ada under Store B with Cashier, without letting Store constrain Job', () => {
		const population = (answers: Array<[string, string[]]>) =>
			ids(
				selectWorkerPopulation(canonicalWorkers, canonical, { answers: new Map(answers) }).workers
			);

		// Store B and Cashier are separate Attribute predicates: Ada holds both even
		// though no single "assignment" pairs them.
		expect(
			population([
				['store', ['store-b']],
				['job', ['cashier']]
			])
		).toEqual(['ada']);

		// Store B alone finds Ada only; Job Cashier alone finds Ada and Bea.
		expect(population([['store', ['store-b']]])).toEqual(['ada']);
		expect(population([['job', ['cashier']]])).toEqual(['ada', 'bea']);

		// A Worker holding several values of one Attribute is still one match.
		expect(population([['store', ['store-a', 'store-b']]])).toEqual(['ada', 'bea']);
	});

	it('reads each empty Attribute of either cardinality as its own no-answer condition', () => {
		expect(
			ids(
				selectWorkerPopulation(canonicalWorkers, canonical, {
					missing: new Set(['store', 'job', 'shift'])
				}).workers
			)
		).toEqual(['cy']);
		expect(
			ids(
				selectWorkerPopulation(canonicalWorkers, canonical, {
					missing: new Set(['job', 'store'])
				}).workers
			)
		).toEqual(['cy']);
	});
});

describe('countAnswerPopulation', () => {
	const ada = worker('ada', { dept: 'store-a-cashier' });
	const bea = worker('bea', { dept: 'store-a' });
	const cy = worker('cy', { dept: 'warehouse' });
	const dee = worker('dee', { dept: '' });
	const workers = [ada, bea, cy, dee];

	it('counts a parent with every descendant and the direct holder separately', () => {
		const counts = countAnswerPopulation(workers, department);

		expect(counts.workers.get('store')).toBe(2);
		expect(counts.workers.get('store-a')).toBe(2);
		expect(counts.workers.get('store-a-cashier')).toBe(1);
		expect(counts.workers.get('warehouse')).toBe(1);
		expect(counts.workers.get('store-b')).toBe(0);

		expect(counts.directWorkers.get('store')).toBe(0);
		expect(counts.directWorkers.get('store-a')).toBe(1);
		expect(counts.directWorkers.get('store-a-cashier')).toBe(1);
		expect(counts.directWorkers.get('warehouse')).toBe(1);
	});

	it('counts each Worker once when answering, however many values they hold', () => {
		const multi = [
			worker('ada', { roles: ['trainer', 'steward'] }),
			worker('bea', { roles: ['steward'] }),
			worker('cy', { roles: [] })
		];
		const counts = countAnswerPopulation(multi, roles);

		expect(counts.workersAnswering).toBe(2);
		expect(counts.workers.get('trainer')).toBe(1);
		expect(counts.workers.get('steward')).toBe(2);
		expect(counts.directWorkers.get('trainer')).toBe(1);
		expect(counts.directWorkers.get('senior-trainer')).toBe(0);
	});

	it('keeps counts independent of another Attribute', () => {
		const withRoles = [worker('ada', { dept: 'store-a', roles: ['steward'] })];

		expect(countAnswerPopulation(withRoles, department).workers.get('store-a')).toBe(1);
		expect(countAnswerPopulation(withRoles, roles).workers.get('steward')).toBe(1);
	});
});

describe('a category with a Multi-Select group (ADR 0043)', () => {
	// Front of House is Multi-Select, so a Worker may hold several of its sub-values while
	// the Attribute's top level still takes one branch. Such a Worker's value is a list.
	const site: WorkerAttributeDefinition = {
		id: 'site',
		name: 'Site',
		kind: 'category',
		answers: [
			{ id: 'foh', value: 'Front of House', mode: 'multi' },
			{ id: 'server', value: 'Server', parentId: 'foh' },
			{ id: 'host', value: 'Host', parentId: 'foh' },
			answer('boh', 'Back of House')
		]
	};
	const fohPair = worker('fo', { site: ['server', 'host'] });
	const boh = worker('bo', { site: 'boh' });

	it('selects a Worker holding two sub-values by their parent and by each one held', () => {
		const selectedBy = (answerId: string) =>
			ids(
				selectWorkerPopulation([fohPair, boh], [site], {
					answers: new Map([['site', [answerId]]])
				}).workers
			);

		expect(selectedBy('foh')).toEqual(['fo']);
		expect(selectedBy('host')).toEqual(['fo']);
		expect(selectedBy('server')).toEqual(['fo']);
	});

	it('does not select that Worker through another top-level branch they do not hold', () => {
		expect(
			ids(
				selectWorkerPopulation([fohPair, boh], [site], {
					answers: new Map([['site', ['boh']]])
				}).workers
			)
		).toEqual(['bo']);
	});

	it('reads a one-element list and a string as the same held id', () => {
		expect(heldAnswerIds(worker('a', { site: ['host'] }), site)).toEqual(['host']);
		expect(heldAnswerIds(worker('a', { site: 'host' }), site)).toEqual(['host']);
	});

	it('counts a Worker holding two sub-values once in each answer count', () => {
		const counts = countAnswerPopulation([fohPair, boh, worker('cy', { site: '' })], site);

		expect(counts.workers.get('foh')).toBe(1);
		expect(counts.workers.get('server')).toBe(1);
		expect(counts.workers.get('host')).toBe(1);
		expect(counts.workers.get('boh')).toBe(1);
		expect(counts.directWorkers.get('foh')).toBe(0);
		expect(counts.workersAnswering).toBe(2);
	});
});

describe('countValueHolders', () => {
	it('counts each saved holder once per value and counts Workers with any', () => {
		const workers = [
			{ ...worker('ada', {}), agitations: ['equipment', 'schedule'] },
			{ ...worker('bea', {}), agitations: ['equipment', 'equipment'] },
			{ ...worker('cy', {}), agitations: [] }
		];

		expect(countValueHolders(workers, 'agitations')).toEqual({
			byId: new Map([
				['equipment', 2],
				['schedule', 1]
			]),
			workersWithAny: 2
		});
	});

	it('counts a folded value toward its survivor once per Worker and drops unlisted values', () => {
		const workers = [
			{ ...worker('ada', {}), languages: ['es', 'spanish', 'fr'] },
			{ ...worker('bea', {}), languages: ['spanish'] },
			{ ...worker('cy', {}), languages: ['fr'] }
		];
		const entries = [{ id: 'es' }, { id: 'spanish', mergedInto: 'es' }];

		expect(countValueHolders(workers, 'languages', entries)).toEqual({
			byId: new Map([['es', 2]]),
			workersWithAny: 2
		});
	});
});
