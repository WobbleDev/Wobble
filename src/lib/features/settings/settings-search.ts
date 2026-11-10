export type SearchableSection = { id: string; label: string; text: string };

const normalise = (value: string) =>
	value
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase();

/**
 * The sections whose label or contents contain every word of the query, in page order.
 * An empty query matches all of them. Accents and case are ignored.
 */
export function matchSections<T extends SearchableSection>(query: string, sections: T[]): T[] {
	const words = normalise(query).split(/\s+/).filter(Boolean);
	if (words.length === 0) return sections;

	return sections.filter((section) => {
		const haystack = normalise(`${section.label} ${section.text}`);
		return words.every((word) => haystack.includes(word));
	});
}
