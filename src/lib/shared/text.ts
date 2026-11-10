/** The form a search query or a matched value takes before comparing: trimmed, then lowercased. */
export function normalizeForMatch(text: string): string {
	return text.trim().toLowerCase();
}
