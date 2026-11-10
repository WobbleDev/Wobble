/** The saved view routes: a Worksite's named Workers and Mapping views. */
import type { SavedView, SavedViewSnapshot } from '#lib/domain-vocabulary.ts';
import { decodeSavedViewReply, decodeSavedViews } from './saved-view-decode.ts';
import { jsonInit, requestJson, requestVoid } from './request-json.ts';

/** The Active Worksite's saved views, by name. */
export function listViews(): Promise<SavedView[]> {
	return requestJson(
		'/api/views',
		{ method: 'GET' },
		(status) => `Could not load the views (HTTP ${status}).`,
		decodeSavedViews
	);
}

/** Saves a new view ("Save as"). */
export function createView(name: string, snapshot: SavedViewSnapshot): Promise<SavedView> {
	return requestJson(
		'/api/views',
		jsonInit('POST', { name, snapshot }),
		(status) => `Could not save the view (HTTP ${status}).`,
		decodeSavedViewReply
	);
}

/** The explicit Update (a snapshot) and Rename (a name) of one view. */
export function updateView(
	id: string,
	change: { name?: string; snapshot?: SavedViewSnapshot }
): Promise<SavedView> {
	return requestJson(
		`/api/views/${encodeURIComponent(id)}`,
		jsonInit('PUT', change),
		(status) => `Could not update the view (HTTP ${status}).`,
		decodeSavedViewReply
	);
}

/** Deletes one view. */
export function deleteView(id: string): Promise<void> {
	return requestVoid(
		`/api/views/${encodeURIComponent(id)}`,
		{ method: 'DELETE' },
		(status) => `Could not delete the view (HTTP ${status}).`
	);
}
