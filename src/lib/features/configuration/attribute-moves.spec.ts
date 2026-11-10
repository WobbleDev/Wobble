import { describe, expect, it } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import {
	createAttribute,
	type AttributeAnswerDraft,
	type AttributeDraft
} from './attribute-draft.ts';
import {
	moveAnswerAmongSiblings,
	moveAnswerBesideSibling,
	rowEdgeZone,
	moveAnswerBranchToAttribute,
	moveRefusal,
	promoteAnswerBranch,
	promoteRefusal,
	restoreAnswerOrder,
	siblingPosition,
	type MoveSource,
	type MoveTarget
} from './attribute-moves.ts';

// Region runs five levels deep: Central > Store A > Floor > Aisle > Shelf. North is a root.
function region(extra: AttributeAnswerDraft[] = []): AttributeDraft {
	return createAttribute('region', 'Region', 'category', [
		{ id: 'central', value: 'Central' },
		{ id: 'store', value: 'Store A', parentId: 'central' },
		{ id: 'floor', value: 'Floor', parentId: 'store' },
		{ id: 'aisle', value: 'Aisle', parentId: 'floor' },
		{ id: 'shelf', value: 'Shelf', parentId: 'aisle' },
		{ id: 'north', value: 'North' },
		...extra
	]);
}

// Site is a tag Attribute: Depot > Dock > Bay 1.
function site(extra: AttributeAnswerDraft[] = []): AttributeDraft {
	return createAttribute('site', 'Site', 'tag', [
		{ id: 'depot', value: 'Depot' },
		{ id: 'dock', value: 'Dock', parentId: 'depot' },
		{ id: 'bay', value: 'Bay 1', parentId: 'dock' },
		...extra
	]);
}

function from(answerId: string, attributeId = 'region'): MoveSource {
	return { attributeId, answerId };
}

function to(attributeId: string, parentId = ''): MoveTarget {
	return { attributeId, parentId };
}

function byId(attributes: readonly AttributeDraft[], id: string): AttributeDraft {
	const found = attributes.find((attribute) => attribute.id === id);
	if (!found) throw new Error(`no Attribute ${id}`);
	return found;
}

function answerIds(attributes: readonly AttributeDraft[], id: string): string[] {
	return byId(attributes, id).answers.map((answer) => answer.id);
}

describe('moveRefusal within one Attribute', () => {
	it('allows moving an answer under a parent outside its own branch', () => {
		expect(moveRefusal([region()], from('north'), to('region', 'store'))).toBe('');
	});

	it('refuses a parent that is not in the Attribute', () => {
		expect(moveRefusal([region()], from('north'), to('region', 'missing'))).toBe(
			m.configuration_move_parent_missing()
		);
	});

	it('refuses a target inside the moved branch, five levels down', () => {
		expect(moveRefusal([region()], from('store'), to('region', 'shelf'))).toBe(
			m.configuration_move_below_descendant()
		);
	});

	it('refuses a target that is the moved answer itself', () => {
		expect(moveRefusal([region()], from('store'), to('region', 'store'))).toBe(
			m.configuration_move_below_descendant()
		);
	});

	it('allows a sibling label clash inside one Attribute, so the move stays for a rename in place', () => {
		const attribute = region([{ id: 'north-a', value: 'NORTH', parentId: 'central' }]);

		expect(moveRefusal([attribute], from('north'), to('region', 'central'))).toBe('');
	});

	it('refuses a move onto its current parent as already here', () => {
		expect(moveRefusal([region()], from('store'), to('region', 'central'))).toBe(
			m.configuration_move_refused_already_here()
		);
	});

	it('refuses a top-level answer dropped at top level as already here', () => {
		expect(moveRefusal([region()], from('north'), to('region', ''))).toBe(
			m.configuration_move_refused_already_here()
		);
	});

	it('allows moving a nested answer back to top level', () => {
		expect(moveRefusal([region()], from('store'), to('region', ''))).toBe('');
	});
});

describe('moveRefusal across Attributes', () => {
	it('allows a deep leaf under a visible answer of another Attribute', () => {
		expect(moveRefusal([region(), site()], from('shelf'), to('site', 'bay'))).toBe('');
	});

	it('refuses a source answer that is missing', () => {
		expect(moveRefusal([region(), site()], from('gone'), to('site', 'bay'))).toBe(
			m.configuration_move_refused_source_missing()
		);
	});

	it('refuses a source Attribute that is missing', () => {
		expect(moveRefusal([region(), site()], from('shelf', 'nope'), to('site', 'bay'))).toBe(
			m.configuration_move_refused_source_missing()
		);
	});

	it('refuses a target Attribute that is missing', () => {
		expect(moveRefusal([region(), site()], from('shelf'), to('nope', ''))).toBe(
			m.configuration_move_refused_target_missing()
		);
	});

	it('refuses a target parent that is not in the target Attribute', () => {
		expect(moveRefusal([region(), site()], from('shelf'), to('site', 'gone'))).toBe(
			m.configuration_move_refused_target_missing()
		);
	});

	it('refuses a target parent that was folded into another answer', () => {
		const target = site([
			{ id: 'old-dock', value: 'Old dock', parentId: 'depot', mergedInto: 'dock' }
		]);

		expect(moveRefusal([region(), target], from('shelf'), to('site', 'old-dock'))).toBe(
			m.configuration_move_refused_target_missing()
		);
	});

	it('refuses a sibling under the target parent that already has the label, naming it', () => {
		const target = site([{ id: 'shelf-x', value: ' shelf ', parentId: 'dock' }]);

		expect(moveRefusal([region(), target], from('shelf'), to('site', 'dock'))).toBe(
			m.configuration_move_refused_name_conflict_target({ name: 'Shelf' })
		);
	});

	it('refuses a branch that holds a folded answer until the merge is resolved', () => {
		const source = region([
			{ id: 'floor-2', value: 'Floor 2', parentId: 'store', mergedInto: 'floor' }
		]);

		expect(moveRefusal([source, site()], from('store'), to('site', 'bay'))).toBe(
			m.configuration_move_refused_pending_merge()
		);
	});

	it('refuses a branch that an answer outside it is folded into', () => {
		const source = region([
			{ id: 'old-north', value: 'Old north', parentId: 'north', mergedInto: 'shelf' }
		]);

		expect(moveRefusal([source, site()], from('shelf'), to('site', 'bay'))).toBe(
			m.configuration_move_refused_pending_merge()
		);
	});
});

describe('moveAnswerBranchToAttribute', () => {
	it('moves a whole five-level branch, keeping ids and the original order', () => {
		const result = moveAnswerBranchToAttribute(
			[region(), site()],
			from('store'),
			to('site', 'bay')
		);

		expect(result).not.toBeNull();
		const attributes = result ?? [];
		expect(answerIds(attributes, 'region')).toEqual(['central', 'north']);
		expect(answerIds(attributes, 'site')).toEqual([
			'depot',
			'dock',
			'bay',
			'store',
			'floor',
			'aisle',
			'shelf'
		]);
	});

	it('re-parents the moved root and keeps the descendants under their own parents', () => {
		const attributes =
			moveAnswerBranchToAttribute([region(), site()], from('store'), to('site', 'bay')) ?? [];
		const answers = byId(attributes, 'site').answers;

		const parentOf = (id: string) => answers.find((answer) => answer.id === id)?.parentId;
		expect(parentOf('store')).toBe('bay');
		expect(parentOf('floor')).toBe('store');
		expect(parentOf('aisle')).toBe('floor');
		expect(parentOf('shelf')).toBe('aisle');
	});

	it('places the moved root at top level when the target parent is empty', () => {
		const attributes =
			moveAnswerBranchToAttribute([region(), site()], from('store'), to('site', '')) ?? [];
		const store = byId(attributes, 'site').answers.find((answer) => answer.id === 'store');

		expect(store?.parentId).toBeUndefined();
	});

	it('moves a single leaf without taking anything else', () => {
		const attributes =
			moveAnswerBranchToAttribute([region(), site()], from('shelf'), to('site', 'bay')) ?? [];

		expect(answerIds(attributes, 'region')).toEqual([
			'central',
			'store',
			'floor',
			'aisle',
			'north'
		]);
		expect(answerIds(attributes, 'site')).toEqual(['depot', 'dock', 'bay', 'shelf']);
	});

	it('does not mutate the attributes it was given', () => {
		const input = [region(), site()];
		const before = structuredClone(input);

		moveAnswerBranchToAttribute(input, from('store'), to('site', 'bay'));

		expect(input).toEqual(before);
	});

	it('returns new Attribute objects and clears stale errors on the Attributes it touched', () => {
		const source = region();
		source.moveError = 'old move';
		source.removalError = 'old removal';
		const input = [source, site()];

		const attributes = moveAnswerBranchToAttribute(input, from('store'), to('site', 'bay')) ?? [];

		expect(byId(attributes, 'region')).not.toBe(source);
		expect(byId(attributes, 'region').moveError).toBe('');
		expect(byId(attributes, 'region').removalError).toBe('');
		expect(byId(attributes, 'site').moveError).toBe('');
	});

	it('returns null for a move inside one Attribute', () => {
		expect(
			moveAnswerBranchToAttribute([region()], from('north'), to('region', 'store'))
		).toBeNull();
	});

	it('returns null when the move is refused', () => {
		expect(
			moveAnswerBranchToAttribute([region(), site()], from('store'), to('site', 'gone'))
		).toBeNull();
	});
});

describe('promoteRefusal', () => {
	it('allows a branch whose label no Attribute uses', () => {
		expect(promoteRefusal([region(), site()], from('store'))).toBe('');
	});

	it('refuses a label that matches an Attribute name, ignoring case and spacing', () => {
		const attributes = [region([{ id: 'site-label', value: ' site ', parentId: 'north' }]), site()];

		expect(promoteRefusal(attributes, from('site-label'))).toBe(
			m.configuration_attribute_name_exists()
		);
	});

	it('refuses a label that matches the source Attribute name', () => {
		const attributes = [region([{ id: 'region-label', value: 'REGION', parentId: 'north' }])];

		expect(promoteRefusal(attributes, from('region-label'))).toBe(
			m.configuration_attribute_name_exists()
		);
	});

	it('refuses a missing answer', () => {
		expect(promoteRefusal([region()], from('gone'))).toBe(
			m.configuration_move_refused_source_missing()
		);
	});

	it('refuses a branch with a pending merge until it is resolved', () => {
		const attributes = [
			region([{ id: 'floor-2', value: 'Floor 2', parentId: 'store', mergedInto: 'floor' }])
		];

		expect(promoteRefusal(attributes, from('store'))).toBe(
			m.configuration_move_refused_pending_merge()
		);
	});
});

describe('promoteAnswerBranch', () => {
	it('moves a branch into a new Attribute placed right after its source, named by the answer', () => {
		const result = promoteAnswerBranch([region(), site()], from('store'));

		expect(result?.map((attribute) => attribute.id)).toEqual(['region', 'store', 'site']);
		const promoted = byId(result ?? [], 'store');
		expect(promoted.name).toBe('Store A');
		expect(promoted.type).toBe('category');
		expect(promoted.answers.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
			{ id: 'floor', parentId: undefined },
			{ id: 'aisle', parentId: 'floor' },
			{ id: 'shelf', parentId: 'aisle' }
		]);
		expect(answerIds(result ?? [], 'region')).toEqual(['central', 'north']);
	});

	it('promotes a top-level answer with its whole five-level tree below it', () => {
		const result = promoteAnswerBranch([region(), site()], from('central')) ?? [];

		expect(result.map((attribute) => attribute.id)).toEqual(['region', 'central', 'site']);
		expect(byId(result, 'central').answers.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
			{ id: 'store', parentId: undefined },
			{ id: 'floor', parentId: 'store' },
			{ id: 'aisle', parentId: 'floor' },
			{ id: 'shelf', parentId: 'aisle' }
		]);
		expect(answerIds(result, 'region')).toEqual(['north']);
	});

	it('keeps the type of the source Attribute and inserts after it, not at the end', () => {
		const result = promoteAnswerBranch([region(), site()], from('dock', 'site')) ?? [];

		expect(result.map((attribute) => attribute.id)).toEqual(['region', 'site', 'dock']);
		expect(byId(result, 'dock').type).toBe('tag');
		expect(byId(result, 'dock').answers.map(({ id, parentId }) => ({ id, parentId }))).toEqual([
			{ id: 'bay', parentId: undefined }
		]);
		expect(answerIds(result, 'site')).toEqual(['depot']);
	});

	it('does not mutate the attributes it was given', () => {
		const input = [region(), site()];
		const before = structuredClone(input);

		promoteAnswerBranch(input, from('store'));

		expect(input).toEqual(before);
	});

	it('returns null when the promotion is refused', () => {
		expect(promoteAnswerBranch([region(), site()], from('gone'))).toBeNull();
	});
});

/** The parentId chain from the top-level root down to one answer, read off the answers. */
function chainOf(attribute: AttributeDraft, answerId: string): string[] {
	const chain: string[] = [];
	let current = attribute.answers.find((answer) => answer.id === answerId);
	while (current) {
		chain.unshift(current.id);
		const parentId = current.parentId;
		current = parentId ? attribute.answers.find((answer) => answer.id === parentId) : undefined;
	}
	return chain;
}

describe('four- and five-level branches keep every descendant and parentId chain', () => {
	it('moves the five-level branch under Central into Site with every descendant and chain', () => {
		const result =
			moveAnswerBranchToAttribute([region(), site()], from('central'), to('site', 'bay')) ?? [];

		expect(answerIds(result, 'region')).toEqual(['north']);
		expect(answerIds(result, 'site')).toEqual([
			'depot',
			'dock',
			'bay',
			'central',
			'store',
			'floor',
			'aisle',
			'shelf'
		]);
		expect(chainOf(byId(result, 'site'), 'shelf')).toEqual([
			'depot',
			'dock',
			'bay',
			'central',
			'store',
			'floor',
			'aisle',
			'shelf'
		]);
		expect(chainOf(byId(result, 'site'), 'central')).toEqual(['depot', 'dock', 'bay', 'central']);
	});

	it('moves a four-level branch to the top level of Site with its chain intact', () => {
		const result =
			moveAnswerBranchToAttribute([region(), site()], from('store'), to('site', '')) ?? [];

		expect(answerIds(result, 'region')).toEqual(['central', 'north']);
		expect(chainOf(byId(result, 'site'), 'store')).toEqual(['store']);
		expect(chainOf(byId(result, 'site'), 'floor')).toEqual(['store', 'floor']);
		expect(chainOf(byId(result, 'site'), 'shelf')).toEqual(['store', 'floor', 'aisle', 'shelf']);
	});

	it('promotes the five-level branch under Central, keeping every descendant and chain', () => {
		const result = promoteAnswerBranch([region(), site()], from('central')) ?? [];
		const promoted = byId(result, 'central');

		expect(answerIds(result, 'central')).toEqual(['store', 'floor', 'aisle', 'shelf']);
		expect(chainOf(promoted, 'store')).toEqual(['store']);
		expect(chainOf(promoted, 'floor')).toEqual(['store', 'floor']);
		expect(chainOf(promoted, 'shelf')).toEqual(['store', 'floor', 'aisle', 'shelf']);
		expect(answerIds(result, 'region')).toEqual(['north']);
	});

	it('promotes the four-level branch under Store A, keeping every descendant and chain', () => {
		const result = promoteAnswerBranch([region(), site()], from('store')) ?? [];
		const promoted = byId(result, 'store');

		expect(answerIds(result, 'store')).toEqual(['floor', 'aisle', 'shelf']);
		expect(chainOf(promoted, 'floor')).toEqual(['floor']);
		expect(chainOf(promoted, 'shelf')).toEqual(['floor', 'aisle', 'shelf']);
		expect(answerIds(result, 'region')).toEqual(['central', 'north']);
	});
});

describe('sibling order', () => {
	const ids = (answers: readonly AttributeAnswerDraft[] | null) => answers?.map((a) => a.id);

	it('swaps only siblings that share a parent, leaving descendants and parents alone', () => {
		const answers = region().answers;
		const moved = moveAnswerAmongSiblings(answers, 'north', -1);
		expect(ids(moved)).toEqual(['north', 'store', 'floor', 'aisle', 'shelf', 'central']);
		expect(moved?.find((a) => a.id === 'store')?.parentId).toBe('central');
		expect(moveAnswerAmongSiblings(answers, 'north', 1)).toBeNull();
		expect(moveAnswerAmongSiblings(answers, 'central', -1)).toBeNull();
		expect(moveAnswerAmongSiblings(answers, 'store', 1)).toBeNull();
	});

	it('skips folded values and reports the place among visible siblings', () => {
		const answers = region([
			{ id: 'east', value: 'East' },
			{ id: 'gone', value: 'Gone', mergedInto: 'east' }
		]).answers;
		expect(siblingPosition(answers, 'east')).toEqual({ position: 3, count: 3 });
		expect(moveAnswerAmongSiblings(answers, 'east', -1)?.map((a) => a.id)).toContain('east');
	});

	it('restores a recorded order', () => {
		const answers = region().answers;
		const moved = moveAnswerAmongSiblings(answers, 'north', -1) ?? [];
		expect(ids(restoreAnswerOrder(moved, ids(answers) ?? []))).toEqual(ids(answers));
	});
});

describe('pointer sibling reorder helpers', () => {
	const list = [
		{ id: 'a', value: 'A' },
		{ id: 'b', value: 'B' },
		{ id: 'c', value: 'C', parentId: 'a' },
		{ id: 'd', value: 'D' }
	];
	it('zones: outer quarters place beside, the middle nests', () => {
		expect(rowEdgeZone(102, 100, 40)).toBe('before');
		expect(rowEdgeZone(120, 100, 40)).toBe('inside');
		expect(rowEdgeZone(135, 100, 40)).toBe('after');
	});
	it('moves a value beside a sibling only', () => {
		const ids = (rows: { id: string }[] | null) => rows?.map((row) => row.id);
		expect(ids(moveAnswerBesideSibling(list, 'd', 'a', false))).toEqual(['d', 'a', 'b', 'c']);
		expect(ids(moveAnswerBesideSibling(list, 'a', 'd', true))).toEqual(['b', 'c', 'd', 'a']);
		expect(moveAnswerBesideSibling(list, 'd', 'c', false)).toBeNull();
		expect(moveAnswerBesideSibling(list, 'a', 'b', false)).toBeNull();
	});
});
