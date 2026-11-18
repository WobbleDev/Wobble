/**
 * One Configuration draft list of named values: its draft entries, the new-entry box and the
 * box's error, plus the add, remove, rename and merge rules. Agitations (`text`) and
 * Languages (`name`) are the same list over a different field, so they share this and the
 * draft state only delegates.
 */
import { newId } from '#lib/shared/text/new-id.ts';
import {
	checkValueText,
	findDuplicateValue,
	mergeValue,
	removeValue,
	renameValue,
	visibleValues,
	type ValueEntry,
	type ValueTextCheck
} from './configuration-draft.ts';

export type ValueList<K extends 'text' | 'name'> = {
	draft: ValueEntry<K>[];
	input: string;
	error: string;
	readonly visible: ValueEntry<K>[];
	add(): void;
	submit(event: SubmitEvent): void;
	remove(id: string): void;
	rename(id: string, text: string): ValueTextCheck;
	merge(foldedId: string, survivorId: string): void;
};

export function createValueList<K extends 'text' | 'name'>(options: {
	/** The field that holds the entry's label. */
	field: K;
	/** The entry a new value adds, in the list's own shape. */
	makeEntry: (id: string, text: string) => ValueEntry<K>;
	/** What the box says when the value is already there. */
	duplicateMessage: () => string;
	/** The draft is locked while a save runs. */
	locked: () => boolean;
}): ValueList<K> {
	let draft = $state<ValueEntry<K>[]>([]);
	let input = $state('');
	let error = $state('');
	const visible = $derived(visibleValues(draft));

	function add() {
		const text = input.trim();
		if (!text || options.locked()) return;
		if (findDuplicateValue(draft, options.field, null, text)) {
			error = options.duplicateMessage();
			return;
		}
		draft = [...draft, options.makeEntry(newId(), text)];
		input = '';
		error = '';
	}

	return {
		get draft() {
			return draft;
		},
		set draft(next: ValueEntry<K>[]) {
			draft = next;
		},
		get input() {
			return input;
		},
		set input(next: string) {
			input = next;
		},
		get error() {
			return error;
		},
		set error(next: string) {
			error = next;
		},
		get visible() {
			return visible;
		},
		add,
		submit(event: SubmitEvent) {
			event.preventDefault();
			add();
		},
		remove(id: string) {
			if (options.locked()) return;
			draft = removeValue(draft, id);
		},
		rename(id: string, text: string): ValueTextCheck {
			const check = checkValueText(draft, options.field, id, text);
			if (check.status === 'ok' && !options.locked()) {
				draft = renameValue(draft, options.field, id, text);
			}
			return check;
		},
		merge(foldedId: string, survivorId: string) {
			if (options.locked()) return;
			draft = mergeValue(draft, foldedId, survivorId);
		}
	};
}
