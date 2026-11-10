/**
 * The Agitations card's composed paging, specced through its factory with a literal
 * host: page slicing by the measured group count, the footer and short-page flags,
 * the visible range, and the grouping reset.
 */
import { describe, expect, it } from 'vitest';
import { createOverviewAgitationsCard } from './overview-agitations-card.svelte.ts';
import type { AgitationMatrixRow } from './support-summary.ts';

function row(answerId: string, workers = 3): AgitationMatrixRow {
	return {
		attributeId: 'department',
		answerId,
		value: answerId,
		workers,
		counts: [1]
	} as unknown as AgitationMatrixRow;
}

function cell(width: number) {
	return { getBoundingClientRect: () => ({ width }) };
}

/** A 700px scroller: four whole 100px groups beside a 144px name and a 64px All. */
function scroller(groups: number, width = 700) {
	return {
		clientWidth: width,
		querySelectorAll: () => [{}, cell(64), ...Array.from({ length: groups }, () => cell(100))],
		querySelector: () => cell(144)
	} as unknown as HTMLElement;
}

function setup(ids: string[], columns: unknown[] = [{}]) {
	let attribute = { id: 'department', answers: [] as never[] };
	let rows = ids.map((id) => row(id));
	const cols = columns;
	const card = createOverviewAgitationsCard({
		attribute: () => attribute,
		matrix: () => ({ rows, columns: cols }),
		locale: () => 'en',
		allLabel: () => 'All'
	});
	return {
		card,
		set(next: string[]) {
			rows = next.map((id) => row(id));
		},
		regroup(id: string) {
			attribute = { id, answers: [] };
		}
	};
}

describe('createOverviewAgitationsCard', () => {
	it('shows no footer and a single unmeasured page before the card has measured', () => {
		const { card } = setup(['a', 'b', 'c']);
		expect(card.paging.ready).toBe(false);
		expect(card.showFooter).toBe(false);
		expect(card.shortPage).toBe(false);
		expect(card.groupingKey).toBe('department|a,b,c');
	});

	it('pages whole columns by the measured count and reads the visible range', () => {
		const { card } = setup(['a', 'b', 'c', 'd', 'e', 'f']);
		card.paging.refresh(scroller(6));
		expect(card.paging.groupsPerPage).toBe(4);
		expect(card.pageCount).toBe(2);
		expect(card.visibleRows.map((r) => r.answerId)).toEqual(['a', 'b', 'c', 'd']);
		expect(card.range).toEqual({ start: 1, end: 4, total: 6 });
		expect(card.shortPage).toBe(false);

		card.paging.goTo(1);
		expect(card.currentPage).toBe(1);
		expect(card.visibleRows.map((r) => r.answerId)).toEqual(['e', 'f']);
		expect(card.range).toEqual({ start: 5, end: 6, total: 6 });
		expect(card.shortPage).toBe(true);
	});

	it('keeps the footer for a single page and drops it with no Agitations', () => {
		const withColumns = setup(['a', 'b']);
		withColumns.card.paging.refresh(scroller(2));
		expect(withColumns.card.pageCount).toBe(1);
		expect(withColumns.card.showFooter).toBe(true);
		const none = setup(['a', 'b'], []);
		none.card.paging.refresh(scroller(2));
		expect(none.card.showFooter).toBe(false);
	});

	it('returns to the first page only when the grouping identity moves', () => {
		const { card, set, regroup } = setup(['a', 'b', 'c', 'd', 'e', 'f']);
		card.paging.refresh(scroller(6));
		card.syncGrouping();
		card.paging.goTo(1);
		set(['a', 'b', 'c', 'd', 'e', 'f']);
		card.syncGrouping();
		expect(card.currentPage).toBe(1);
		regroup('site');
		card.syncGrouping();
		expect(card.currentPage).toBe(0);
	});
});
