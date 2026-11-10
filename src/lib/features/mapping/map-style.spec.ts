// @module-tag mapping
import { describe, expect, it } from 'vitest';
import {
	hitRadius,
	isEgoLink,
	linkOpacity,
	nodeOpacity,
	nodeRadius,
	screenFixed,
	showsLabel
} from './map-style.ts';
import type { MapViewModel } from './map-view-model.ts';
import type { WorkerGraphLink, WorkerGraphNode } from './worker-relationship-map-model.ts';

describe('nodeRadius', () => {
	it('spans 4 user units alone to the 24-unit cap', () => {
		expect(nodeRadius(0)).toBe(4);
		expect(nodeRadius(1)).toBe(8);
		expect(nodeRadius(3)).toBe(16);
		expect(nodeRadius(5)).toBe(24);
	});

	it('caps larger hubs at 24, so a radius never reports an exact count', () => {
		for (const degree of [5, 64, 167, 499]) {
			expect(nodeRadius(degree)).toBe(24);
		}
	});

	it('is finite and never decreases as the count grows', () => {
		let previous = nodeRadius(0);
		for (let degree = 1; degree <= 600; degree += 1) {
			const radius = nodeRadius(degree);
			expect(Number.isFinite(radius)).toBe(true);
			expect(radius).toBeLessThanOrEqual(24);
			expect(radius).toBeGreaterThanOrEqual(previous);
			previous = radius;
		}
	});

	it('treats missing or negative counts as alone', () => {
		expect(nodeRadius(-3)).toBe(4);
		expect(nodeRadius(Number.NaN)).toBe(4);
	});
});

/** The view model a reading rule is asked about, with only the fields it reads set. */
function viewModelOf(overrides: Partial<MapViewModel> = {}): MapViewModel {
	return {
		effectiveLayout: 'free',
		isolated: false,
		layoutNodes: [],
		layoutLinks: [],
		visibleNodes: [],
		visibleLinks: [],
		selectedId: '',
		hoveredId: '',
		ghostedIds: new Set(),
		labelIds: new Set(),
		restingLabelIds: new Set(),
		spotlightIds: new Set(),
		highlightIds: undefined,
		linkRegions: new Map(),
		...overrides
	};
}

function linkOf(id: string, source: string, target: string): WorkerGraphLink {
	return { id, source, target, value: 1 };
}

function nodeOf(id: string): WorkerGraphNode {
	return { id, name: id, assessment: 'Unassessed', attributes: {}, relationshipCount: 0 };
}

describe('nodeOpacity with a highlight', () => {
	it('fades a Worker the highlight does not select to 0.28', () => {
		expect(nodeOpacity(nodeOf('a'), viewModelOf({ highlightIds: new Set(['b']) }))).toBe(0.28);
	});

	it('leaves a Worker the highlight selects at 0.94', () => {
		expect(nodeOpacity(nodeOf('a'), viewModelOf({ highlightIds: new Set(['a']) }))).toBe(0.94);
	});

	it('leaves everyone at full strength when there is no complete query', () => {
		expect(nodeOpacity(nodeOf('a'), viewModelOf({ highlightIds: undefined }))).toBe(0.94);
	});

	it('fades everyone under an empty highlight set, but not the selected Worker', () => {
		const viewModel = viewModelOf({ highlightIds: new Set(), selectedId: 'a' });
		expect(nodeOpacity(nodeOf('a'), viewModel)).toBe(1);
		expect(nodeOpacity(nodeOf('b'), viewModel)).toBe(0.28);
	});

	it('keeps a non-member hovered Worker at full strength', () => {
		const viewModel = viewModelOf({ highlightIds: new Set(['b']), hoveredId: 'a' });
		expect(nodeOpacity(nodeOf('a'), viewModel)).toBe(1);
	});
});

describe('highlight combined with the spotlight', () => {
	it('fades a Worker in the spotlight but outside the highlight', () => {
		const viewModel = viewModelOf({
			spotlightIds: new Set(['a']),
			highlightIds: new Set(['b'])
		});
		expect(nodeOpacity(nodeOf('a'), viewModel)).toBe(0.28);
	});

	it('fades a Worker inside the highlight but outside the spotlight', () => {
		const viewModel = viewModelOf({
			spotlightIds: new Set(['a']),
			highlightIds: new Set(['b'])
		});
		expect(nodeOpacity(nodeOf('b'), viewModel)).toBe(0.28);
	});

	it('leaves a Worker in both at full strength', () => {
		const viewModel = viewModelOf({
			spotlightIds: new Set(['a']),
			highlightIds: new Set(['a'])
		});
		expect(nodeOpacity(nodeOf('a'), viewModel)).toBe(0.94);
	});
});

describe('showsLabel with a highlight', () => {
	it('drops the label of a Worker the highlight fades', () => {
		const viewModel = viewModelOf({ labelIds: new Set(['a']), highlightIds: new Set(['b']) });
		expect(showsLabel('a', viewModel)).toBe(false);
	});

	it('keeps the label of a selected Worker outside the highlight', () => {
		const viewModel = viewModelOf({
			labelIds: new Set(['a']),
			highlightIds: new Set(['b']),
			selectedId: 'a'
		});
		expect(showsLabel('a', viewModel)).toBe(true);
	});
});

describe('linkOpacity with a highlight', () => {
	it('fades a tie with one end outside the highlight to 0.12', () => {
		const link = linkOf('l', 'a', 'b');
		expect(linkOpacity(link, viewModelOf({ highlightIds: new Set(['a']) }))).toBe(0.12);
	});

	it('does not fade a tie with both ends inside the highlight', () => {
		const link = linkOf('l', 'a', 'b');
		expect(linkOpacity(link, viewModelOf({ highlightIds: new Set(['a', 'b']) }))).toBe(0.5);
	});

	it('keeps the selected Worker tie at 0.9 even when its far end is outside', () => {
		const link = linkOf('l', 'a', 'b');
		expect(linkOpacity(link, viewModelOf({ highlightIds: new Set(['b']), selectedId: 'a' }))).toBe(
			0.9
		);
	});
});

describe('screenFixed', () => {
	it('divides by zoom, so a size holds its screen size at every camera scale', () => {
		expect(screenFixed(12, 0.5)).toBe(24);
		expect(screenFixed(12, 1)).toBe(12);
		expect(screenFixed(12, 4)).toBe(3);
	});

	it('ignores a broken zoom', () => {
		expect(screenFixed(12, 0)).toBe(12);
		expect(screenFixed(12, -1)).toBe(12);
		expect(screenFixed(12, Number.NaN)).toBe(12);
		expect(screenFixed(12, Number.POSITIVE_INFINITY)).toBe(12);
	});
});

describe('hitRadius', () => {
	it('reaches 12 screen px for a lone worker at 1x', () => {
		expect(hitRadius(3, 1)).toBe(12);
	});

	it('grows in map units when zoomed out, so the target stays 24px', () => {
		expect(hitRadius(3, 0.5)).toBe(24);
	});

	it('keeps a 6-unit apron on a hub', () => {
		expect(hitRadius(10, 1)).toBe(16);
	});
});

describe('showsLabel', () => {
	const labelled = new Set(['a']);

	it('draws a labelled Worker that is neither ghosted nor outside the spotlight', () => {
		expect(showsLabel('a', viewModelOf({ labelIds: labelled }))).toBe(true);
	});

	it('draws nothing for an unlabelled Worker', () => {
		expect(showsLabel('b', viewModelOf({ labelIds: labelled }))).toBe(false);
	});

	it('drops a ghosted label', () => {
		expect(showsLabel('a', viewModelOf({ labelIds: labelled, ghostedIds: new Set(['a']) }))).toBe(
			false
		);
	});

	it('drops a label outside a non-empty spotlight', () => {
		expect(showsLabel('a', viewModelOf({ labelIds: labelled, spotlightIds: new Set(['b']) }))).toBe(
			false
		);
		expect(
			showsLabel('a', viewModelOf({ labelIds: labelled, spotlightIds: new Set(['a', 'b']) }))
		).toBe(true);
	});

	it('keeps the selected and the hovered Worker, whatever else is true of them', () => {
		expect(
			showsLabel(
				'a',
				viewModelOf({
					labelIds: labelled,
					ghostedIds: new Set(['a']),
					spotlightIds: new Set(['b']),
					selectedId: 'a'
				})
			)
		).toBe(true);
		expect(
			showsLabel(
				'a',
				viewModelOf({
					labelIds: labelled,
					ghostedIds: new Set(['a']),
					spotlightIds: new Set(['b']),
					hoveredId: 'a'
				})
			)
		).toBe(true);
	});
});

describe('linkOpacity', () => {
	it('draws a cross tie above a within tie and an ungrouped tie between them', () => {
		const link = linkOf('l', 'a', 'b');
		expect(linkOpacity(link, viewModelOf({ linkRegions: new Map([['l', 'cross']]) }))).toBe(0.6);
		expect(linkOpacity(link, viewModelOf({ linkRegions: new Map([['l', 'within']]) }))).toBe(0.35);
		expect(linkOpacity(link, viewModelOf())).toBe(0.5);
	});

	it('keeps the ghosted and spotlight stops where they were', () => {
		const link = linkOf('l', 'a', 'b');
		expect(linkOpacity(link, viewModelOf({ ghostedIds: new Set(['b']) }))).toBe(0.1);
		expect(
			linkOpacity(
				link,
				viewModelOf({ spotlightIds: new Set(['a']), linkRegions: new Map([['l', 'cross']]) })
			)
		).toBe(0.12);
	});

	it('emphasizes a tie touching the selected worker unless an endpoint is ghosted', () => {
		const ego = linkOf('ego', 'a', 'b');
		const other = linkOf('other', 'b', 'c');
		const viewModel = viewModelOf({ selectedId: 'a' });
		expect(isEgoLink(ego, viewModel)).toBe(true);
		expect(isEgoLink(other, viewModel)).toBe(false);
		expect(linkOpacity(ego, viewModel)).toBe(0.9);
		expect(linkOpacity(ego, viewModelOf({ selectedId: 'a', ghostedIds: new Set(['b']) }))).toBe(
			0.1
		);
	});
});
