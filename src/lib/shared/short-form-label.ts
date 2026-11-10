/**
 * The display rule for Short forms (ADR 0046). Pure: it decides which text a narrow view
 * shows for each Attribute value from the full name, the stored Short form, the ancestor
 * path and the column budget. Callers supply the measurement of their own rendered voice.
 *
 * A value shows its full name when that fits the budget and its Short form otherwise. Values
 * that would then show the same text are told apart by the fewest nearest ancestors, each
 * shown by the same rule and joined root first with " › ". Values that no ancestor can tell
 * apart fall back to their full names, so no counter is ever invented. The choice is made
 * over the whole set at once: input order and the page being shown play no part in it.
 */

const SEPARATOR = ' › ';

/** One value to label, with its ancestors nearest first. */
export type ShortFormLabelEntry = {
	id: string;
	/** The full name. */
	value: string;
	/** The stored Short form; absent for a value that has none yet. */
	shortForm?: string;
	ancestors?: readonly { value: string; shortForm?: string }[];
	/** A system reading (No value) is always shown in full. */
	system?: boolean;
};

export type ShortFormLabelOptions = {
	/** The rendered width of a label in the view's own voice. */
	measure: (label: string) => number;
	/** The width one label may take before its Short form is shown instead. */
	budget: number;
	/** Headings that no value may be mistaken for, such as All. */
	reserved?: readonly string[];
};

/** Case and punctuation do not make two labels different. */
function identity(label: string): string {
	return label
		.normalize('NFC')
		.toUpperCase()
		.replace(/[\p{P}\p{Z}\s]/gu, '');
}

export function chooseShortFormLabels(
	entries: readonly ShortFormLabelEntry[],
	{ measure, budget, reserved = [] }: ShortFormLabelOptions
): ReadonlyMap<string, string> {
	const own = (item: { value: string; shortForm?: string }) =>
		item.shortForm !== undefined && measure(item.value) > budget ? item.shortForm : item.value;
	const reservedKeys = new Set(reserved.map(identity));

	type State = { entry: ShortFormLabelEntry; depth: number; full: boolean };
	const states: State[] = entries.map((entry) => ({ entry, depth: 0, full: false }));

	const label = ({ entry, depth, full }: State): string => {
		const self = entry.system || full ? entry.value : own(entry);
		const path = (entry.ancestors ?? []).slice(0, depth).map(own).reverse();
		return [...path, self].join(SEPARATOR);
	};

	// Each pass moves every colliding value one step toward a distinct label: one more
	// ancestor while it has one, then its full name. Every step consumes a finite resource,
	// so the loop ends.
	for (;;) {
		const shown = new Map<string, State[]>();
		for (const state of states) {
			const key = identity(label(state));
			shown.set(key, [...(shown.get(key) ?? []), state]);
		}
		let moved = false;
		for (const [key, group] of shown) {
			const clash = group.length > 1 || reservedKeys.has(key);
			if (!clash) continue;
			for (const state of group) {
				if (state.entry.system) continue;
				if (state.depth < (state.entry.ancestors?.length ?? 0)) {
					state.depth += 1;
					moved = true;
				} else if (!state.full && own(state.entry) !== state.entry.value) {
					state.full = true;
					moved = true;
				}
			}
		}
		if (!moved) break;
	}

	return new Map(states.map((state) => [state.entry.id, label(state)]));
}
