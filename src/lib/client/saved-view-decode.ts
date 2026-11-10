/**
 * Decoding saved views from the core. A reply is untrusted data: the version, the kind and
 * every field must be exactly what this client knows, or the view is refused. Nothing is
 * repaired or defaulted, so a view the client cannot read never reaches Apply.
 */
import type {
	SavedView,
	SavedViewKind,
	SavedViewMapping,
	SavedViewPopulation,
	SavedViewSnapshot,
	SavedViewWorkers
} from '#lib/domain-vocabulary.ts';
import { isRecord } from './api-decode.ts';

const SNAPSHOT_VERSION = 1;

function refuse(what: string): never {
	throw new Error(`Server returned an invalid saved view (${what}).`);
}

/** The record, with exactly these keys: an unknown or missing field is refused. */
function exact(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (!isRecord(value)) return refuse(what);
	const present = Object.keys(value);
	if (present.length !== keys.length || !keys.every((key) => key in value)) return refuse(what);
	return value;
}

function text(value: unknown, what: string): string {
	return typeof value === 'string' ? value : refuse(what);
}

function flag(value: unknown, what: string): boolean {
	return typeof value === 'boolean' ? value : refuse(what);
}

function list(value: unknown, what: string): string[] {
	if (!Array.isArray(value)) return refuse(what);
	return value.map((entry) => text(entry, what));
}

function lists(value: unknown, what: string): Record<string, string[]> {
	if (!isRecord(value)) return refuse(what);
	return Object.fromEntries(Object.entries(value).map(([id, ids]) => [id, list(ids, what)]));
}

function population(value: unknown): SavedViewPopulation {
	const record = exact(value, ['answers', 'exactAnswers', 'missing'], 'population');
	return {
		answers: lists(record.answers, 'answers'),
		exactAnswers: lists(record.exactAnswers, 'exactAnswers'),
		missing: list(record.missing, 'missing')
	};
}

function workersView(value: unknown): SavedViewWorkers {
	const record = exact(value, ['filters', 'sort', 'hiddenColumns', 'order'], 'workers');
	const filters = exact(
		record.filters,
		['population', 'agitations', 'languages', 'assessments'],
		'filters'
	);
	if (!Array.isArray(record.sort)) return refuse('sort');
	return {
		filters: {
			population: population(filters.population),
			agitations: list(filters.agitations, 'agitations'),
			languages: list(filters.languages, 'languages'),
			assessments: list(filters.assessments, 'assessments')
		},
		sort: record.sort.map((entry) => {
			const sort = exact(entry, ['column', 'descending'], 'sort');
			return { column: text(sort.column, 'sort'), descending: flag(sort.descending, 'sort') };
		}),
		hiddenColumns: list(record.hiddenColumns, 'hiddenColumns'),
		order: list(record.order, 'order')
	};
}

function mappingView(value: unknown): SavedViewMapping {
	const record = exact(
		value,
		['grouping', 'detail', 'layout', 'population', 'visibility', 'highlight'],
		'mapping'
	);
	const grouping = exact(record.grouping, ['group', 'subGroup'], 'grouping');
	const detail = exact(record.detail, ['expanded', 'expandedSub'], 'detail');
	const visibility = exact(record.visibility, ['assessments', 'values', 'languages'], 'visibility');
	const highlight = exact(record.highlight, ['query'], 'highlight');
	if (record.layout !== 'grouped' && record.layout !== 'free') return refuse('layout');
	return {
		grouping: {
			group: text(grouping.group, 'group'),
			subGroup: text(grouping.subGroup, 'subGroup')
		},
		detail: {
			expanded: list(detail.expanded, 'expanded'),
			expandedSub: list(detail.expandedSub, 'expandedSub')
		},
		layout: record.layout,
		population: population(record.population),
		visibility: {
			assessments: list(visibility.assessments, 'assessments'),
			values: lists(visibility.values, 'values'),
			languages: list(visibility.languages, 'languages')
		},
		highlight: { query: text(highlight.query, 'query') }
	};
}

/** A snapshot read strictly; any other version, kind or field throws. */
export function decodeSnapshot(value: unknown): SavedViewSnapshot {
	if (!isRecord(value)) return refuse('snapshot');
	if (value.version !== SNAPSHOT_VERSION) return refuse('unsupported version');
	if (value.kind === 'workers') {
		exact(value, ['version', 'kind', 'workers'], 'snapshot');
		return { version: SNAPSHOT_VERSION, kind: 'workers', workers: workersView(value.workers) };
	}
	if (value.kind === 'mapping') {
		exact(value, ['version', 'kind', 'mapping'], 'snapshot');
		return { version: SNAPSHOT_VERSION, kind: 'mapping', mapping: mappingView(value.mapping) };
	}
	return refuse('unknown kind');
}

/** One stored view, with its snapshot read strictly and its kind agreeing with it. */
export function decodeSavedView(value: unknown): SavedView {
	const record = exact(value, ['id', 'name', 'kind', 'snapshot', 'createdAt', 'updatedAt'], 'view');
	const snapshot = decodeSnapshot(record.snapshot);
	const kind: SavedViewKind = snapshot.kind;
	if (record.kind !== kind) return refuse('kind');
	return {
		id: text(record.id, 'id'),
		name: text(record.name, 'name'),
		kind,
		snapshot,
		createdAt: text(record.createdAt, 'createdAt'),
		updatedAt: text(record.updatedAt, 'updatedAt')
	};
}

/** The views of a `{views}` reply. */
export function decodeSavedViews(value: unknown): SavedView[] {
	if (!isRecord(value) || !Array.isArray(value.views)) return refuse('views');
	return value.views.map(decodeSavedView);
}

/** The view of a `{view}` reply. */
export function decodeSavedViewReply(value: unknown): SavedView {
	if (!isRecord(value)) return refuse('reply');
	return decodeSavedView(value.view);
}
