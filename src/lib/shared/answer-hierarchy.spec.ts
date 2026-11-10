import { describe, expect, it } from 'vitest';
import type { WorkerAttributeDefinition } from '#lib/domain-vocabulary.ts';
import {
	branchAnswerIds,
	collapseBranch,
	expandBranch,
	frontier,
	isRemainderIdentity,
	isSystemRegionIdentity,
	normalizeExpansion,
	parseRemainderIdentity,
	remainderIdentity,
	remainderReading
} from './answer-hierarchy.ts';

const location: WorkerAttributeDefinition = {
	id: 'location',
	name: 'Location',
	kind: 'category',
	answers: [
		{ id: 'central', value: 'Central' },
		{ id: 'store-a', value: 'Store A', parentId: 'central' },
		{ id: 'packing', value: 'Packing', parentId: 'store-a' },
		{ id: 'store-b', value: 'Store B', parentId: 'central' },
		{ id: 'distribution', value: 'Distribution' },
		{ id: 'packing-distribution', value: 'Packing', parentId: 'distribution' },
		{ id: 'remote', value: 'Remote' }
	]
};

function regionSummary(attribute: WorkerAttributeDefinition, expanded: string[] = []) {
	return frontier(attribute, expanded).regions.map((region) => [
		region.kind,
		region.answerId,
		region.label,
		region.depth,
		region.expandable
	]);
}

describe('frontier', () => {
	it('starts at the roots and includes every descendant in an unexpanded region', () => {
		const result = frontier(location, new Set());
		expect(result.regions.map((region) => region.identity)).toEqual([
			'central',
			'distribution',
			'remote'
		]);
		expect(result.regions.every((region) => region.kind === 'answer')).toBe(true);
		// Central is one broad region; Store A and Packing are inside it, not rows of
		// their own. Distribution is the second root; Remote is a leaf.
		expect(result.expandable).toEqual(new Set(['central', 'store-a', 'distribution']));
	});

	it('replaces an expanded branch with its direct children in configured order, then the remainder', () => {
		const regions = frontier(location, ['central']).regions;
		expect(
			regions.map((region) => [region.kind, region.answerId, region.depth, region.expanded])
		).toEqual([
			['answer', 'store-a', 1, false],
			['answer', 'store-b', 1, false],
			['remainder', 'central', 0, true],
			['answer', 'distribution', 0, false],
			['answer', 'remote', 0, false]
		]);
		expect(regions.find((region) => region.kind === 'remainder')?.description).toBe(
			'this group only'
		);
	});

	it('keeps an unexpanded child region including its own descendants, at an uneven depth', () => {
		const regions = frontier(location, ['central']).regions;
		// Store A is one region even though Packing sits beneath it; expansion is
		// per branch, so no global depth is imposed.
		expect(regions.some((region) => region.answerId === 'packing')).toBe(false);
		expect(regions[0]).toMatchObject({ answerId: 'store-a', expandable: true, depth: 1 });
	});

	it('expands a deeper branch without expanding its siblings', () => {
		expect(regionSummary(location, ['central', 'store-a'])).toEqual([
			['answer', 'packing', 'Central / Store A / Packing', 2, false],
			['remainder', 'store-a', 'Store A', 1, true],
			['answer', 'store-b', 'Store B', 1, false],
			['remainder', 'central', 'Central', 0, true],
			['answer', 'distribution', 'Distribution', 0, true],
			['answer', 'remote', 'Remote', 0, false]
		]);
	});

	it('distinguishes same-named answers under different parents by path', () => {
		const expanded = frontier(location, ['central', 'store-a', 'distribution']).regions;
		const packingRows = expanded.filter((region) => region.answerId.startsWith('packing'));
		expect(packingRows.map((region) => region.label)).toEqual([
			'Central / Store A / Packing',
			'Distribution / Packing'
		]);
		// A unique label stays short.
		expect(expanded.find((region) => region.answerId === 'store-b')?.label).toBe('Store B');
	});

	it('offers no child level for a leaf', () => {
		const regions = frontier(location, ['remote']).regions;
		expect(regions).toHaveLength(3);
		expect(regions.find((region) => region.answerId === 'remote')?.expandable).toBe(false);
	});
});

describe('normalizeExpansion', () => {
	it('keeps only answers with children and closes over every ancestor', () => {
		expect(normalizeExpansion(location, ['store-a'])).toEqual(['central', 'store-a']);
		expect(normalizeExpansion(location, ['packing'])).toEqual([]);
	});

	it('drops foreign, removed, leaf and duplicated ids and returns configured order', () => {
		expect(
			normalizeExpansion(location, ['store-a', 'store-a', 'ghost', 'remote', 'distribution'])
		).toEqual(['central', 'store-a', 'distribution']);
		expect(normalizeExpansion(location, [])).toEqual([]);
	});
});

describe('branch expansion helpers', () => {
	it('expands a branch with its ancestors', () => {
		expect(expandBranch(location, [], 'store-a')).toEqual(['central', 'store-a']);
	});

	it('collapses the branch and every deeper expansion beneath it', () => {
		const expanded = ['central', 'store-a', 'distribution'];
		expect(collapseBranch(location, expanded, 'store-a')).toEqual(['central', 'distribution']);
		expect(collapseBranch(location, expanded, 'central')).toEqual(['distribution']);
	});

	it('reports the branch under an answer including the answer itself', () => {
		expect([...branchAnswerIds(location, 'central')].sort()).toEqual([
			'central',
			'packing',
			'store-a',
			'store-b'
		]);
	});
});

describe('remainder identity', () => {
	it('is a typed system identity, never an answer id', () => {
		const identity = remainderIdentity('location', 'central');
		expect(identity).toBe('#self:location:central');
		expect(isRemainderIdentity(identity)).toBe(true);
		expect(isRemainderIdentity('central')).toBe(false);
		expect(isSystemRegionIdentity(identity)).toBe(true);
		expect(isSystemRegionIdentity('central')).toBe(false);
		expect(isSystemRegionIdentity('')).toBe(true);
	});

	it('round-trips the Attribute and answer', () => {
		expect(parseRemainderIdentity(remainderIdentity('location', 'store-a'))).toEqual({
			attributeId: 'location',
			answerId: 'store-a'
		});
		expect(parseRemainderIdentity('#self:location')).toBeNull();
		expect(parseRemainderIdentity('location:central')).toBeNull();
		expect(parseRemainderIdentity('#self::central')).toBeNull();
	});

	it('reads as the answer label with the group-only description', () => {
		const reading = remainderReading(location, 'central');
		expect(reading.label).toBe('Central');
		expect(reading.description).toBe('this group only');
	});
});

// Region runs five levels deep: Central > Store A > Floor > Aisle > Shelf. North is a root leaf.
const region: WorkerAttributeDefinition = {
	id: 'region',
	name: 'Region',
	kind: 'category',
	answers: [
		{ id: 'l1', value: 'Central' },
		{ id: 'l2', value: 'Store A', parentId: 'l1' },
		{ id: 'l3', value: 'Floor', parentId: 'l2' },
		{ id: 'l4', value: 'Aisle', parentId: 'l3' },
		{ id: 'l5', value: 'Shelf', parentId: 'l4' },
		{ id: 'north', value: 'North' }
	]
};

describe('five-level hierarchy', () => {
	it('expands every ancestor of a level-4 branch, in configured order', () => {
		expect(normalizeExpansion(region, ['l4'])).toEqual(['l1', 'l2', 'l3', 'l4']);
		expect(normalizeExpansion(region, ['l5', 'l4', 'l4'])).toEqual(['l1', 'l2', 'l3', 'l4']);
	});

	it('drops a level-5 leaf, which has nothing to expand', () => {
		expect(normalizeExpansion(region, ['l5'])).toEqual([]);
	});

	it('collects the whole five-level branch under the root and under level 2', () => {
		expect([...branchAnswerIds(region, 'l1')].sort()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
		expect([...branchAnswerIds(region, 'l2')].sort()).toEqual(['l2', 'l3', 'l4', 'l5']);
	});

	it('expands a level-4 branch in one step and collapses level 2 with everything below it', () => {
		expect(expandBranch(region, [], 'l4')).toEqual(['l1', 'l2', 'l3', 'l4']);
		expect(collapseBranch(region, ['l1', 'l2', 'l3', 'l4'], 'l2')).toEqual(['l1']);
	});

	it('shows the level-5 answer and a remainder at every expanded level', () => {
		expect(regionSummary(region, ['l1', 'l2', 'l3', 'l4'])).toEqual([
			['answer', 'l5', 'Shelf', 4, false],
			['remainder', 'l4', 'Aisle', 3, true],
			['remainder', 'l3', 'Floor', 2, true],
			['remainder', 'l2', 'Store A', 1, true],
			['remainder', 'l1', 'Central', 0, true],
			['answer', 'north', 'North', 0, false]
		]);
	});

	it('keeps a level-4 answer as one broad region until its branch is expanded', () => {
		expect(regionSummary(region, ['l1', 'l2', 'l3'])).toEqual([
			['answer', 'l4', 'Aisle', 3, true],
			['remainder', 'l3', 'Floor', 2, true],
			['remainder', 'l2', 'Store A', 1, true],
			['remainder', 'l1', 'Central', 0, true],
			['answer', 'north', 'North', 0, false]
		]);
	});

	it('shows only the roots when nothing is expanded', () => {
		expect(regionSummary(region, [])).toEqual([
			['answer', 'l1', 'Central', 0, true],
			['answer', 'north', 'North', 0, false]
		]);
	});
});
