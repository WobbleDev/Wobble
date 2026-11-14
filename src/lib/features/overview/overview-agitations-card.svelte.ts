import type { AttributeAnswer } from '#lib/domain-vocabulary.ts';
import { answerPath } from '#lib/shared/answer-path.ts';
import { clampPageIndex, groupPageRange, paginateGroups } from './agitations-paging.ts';
import { createAgitationsHeaders } from './agitations-headers.svelte.ts';
import { createAgitationsPaging } from './agitations-paging.svelte.ts';
import type { AgitationMatrixRow } from './support-summary.ts';

/**
 * The Agitations card's page behaviour: the headers and paging factories composed, and
 * everything the card reads from them (the visible group columns, the page position, the
 * footer and short-page flags). The card pages whole group columns instead of scrolling
 * them: each page holds as many whole groups as fit beside the pinned All column. Page
 * state is local card state: it resets whenever the grouping identity moves, and it never
 * enters the address.
 */
export interface OverviewAgitationsCardHost {
	attribute(): { id: string; answers: readonly AttributeAnswer[] } | undefined;
	matrix(): { rows: readonly AgitationMatrixRow[]; columns: readonly unknown[] };
	locale(): string;
	allLabel(): string;
}

export function createOverviewAgitationsCard(host: OverviewAgitationsCardHost) {
	const headers = createAgitationsHeaders({
		// Include unoccupied values: counts and page turns must not rename a value.
		values: () => [
			...(host.attribute()?.answers ?? []).map((answer) => ({
				id: answer.id,
				value: answer.value,
				abbreviation: answer.abbreviation,
				// Nearest ancestor first: the path runs root to the value itself.
				ancestors: answerPath(host.attribute()?.answers ?? [], answer.id)
					.slice(0, -1)
					.reverse()
			})),
			...host
				.matrix()
				.rows.filter((row) => row.noValue)
				.map((row) => ({ id: row.answerId, value: row.value, system: true }))
		],
		locale: host.locale,
		allLabel: host.allLabel,
		largestGroup: () => Math.max(0, ...host.matrix().rows.map((row) => row.workers)),
		// A lone page stretches its own columns across the card; with several pages every
		// page keeps a full page's columns (a short last page is padded). Both are read
		// only when the labels are chosen, after the paging factory below exists.
		columnsPerPage: () =>
			pageCount > 1 ? paging.groupsPerPage : Math.max(1, host.matrix().rows.length)
	});

	// The grouping identity the pages slice: the grouping choice plus the row
	// answer ids. A data change that keeps the same groups leaves the page
	// where the reader left it.
	const groupingKey = $derived(
		(host.attribute()?.id ?? '') +
			'|' +
			host
				.matrix()
				.rows.map((row) => row.answerId)
				.join(',')
	);
	const paging = createAgitationsPaging({
		pageCount: () => pageCount,
		groupingKey: () => groupingKey
	});

	const pages = $derived(paginateGroups(host.matrix().rows, paging.groupsPerPage));
	const pageCount = $derived(pages.length);
	const currentPage = $derived(clampPageIndex(paging.page, pageCount));
	const visibleRows = $derived(pages[currentPage] ?? []);
	/* The footer stays once the card has measured: a single page reads its own
	   range with both turns disabled, so the note always matches what is shown. */
	const showFooter = $derived(paging.ready && host.matrix().columns.length > 0);
	const hasMultiplePages = $derived(paging.ready && pageCount > 1);
	const shortPage = $derived(hasMultiplePages && visibleRows.length < paging.groupsPerPage);
	const range = $derived(groupPageRange(pages, currentPage));

	return {
		headers,
		paging,
		get groupingKey() {
			return groupingKey;
		},
		get pages() {
			return pages;
		},
		get pageCount() {
			return pageCount;
		},
		get currentPage() {
			return currentPage;
		},
		get visibleRows() {
			return visibleRows;
		},
		get showFooter() {
			return showFooter;
		},
		get shortPage() {
			return shortPage;
		},
		get range() {
			return range;
		},
		/** The single reset effect: a grouping move returns to the first page. */
		syncGrouping: () => paging.syncGrouping(),
		/** Font measurement for the column labels; watches the fixed scroller. */
		observeHeaders: (scroller: HTMLElement | undefined) => headers.observe(scroller),
		/** Refit when font measurement changes the column minimum. */
		observeFit: (scroller: HTMLElement | undefined) => {
			void groupingKey;
			void headers.width;
			void headers.availableWidth;
			return paging.observe(scroller);
		}
	};
}
