/**
 * Duplicate suggestions for an import: which Workers the Worksite already holds that an
 * incoming row may be. A suggestion names its reasons and nothing else: no score, no
 * ranking, no strongest match. Rows are read in CSV order and candidates in the Worksite's
 * Worker order, each with its reasons in the fixed order phone, email, name. Nothing here
 * decides; the organizer skips the row or creates it separately, and merges by hand later.
 */
import { normalizePhone } from '../phone.ts';

export type DuplicateReason = 'phone' | 'email' | 'name';

export const duplicateReasonOrder: readonly DuplicateReason[] = ['phone', 'email', 'name'];

export type ExistingContact = { id: string; name: string; email: string; phone: string };

export type DuplicateSuggestion = {
	workerId: string;
	workerName: string;
	reasons: DuplicateReason[];
};

type Keys = { phone: string; email: string; name: string };

/** The same number, in the stored shape; anything that is not a clean number has no key. */
function phoneKey(phone: string) {
	return normalizePhone(phone) ?? '';
}

function emailKey(email: string) {
	return email.trim().toLocaleLowerCase();
}

/**
 * A weaker signal than phone or email: the same words in any order and case, ignoring
 * accents and punctuation ("Lovelace, Ada" and "ada lovelace").
 */
function nameKey(name: string) {
	return name
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLocaleLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
		.sort()
		.join(' ');
}

type Contact = { name: string; email?: string; phone?: string };

function keys(contact: Contact): Keys {
	return {
		phone: phoneKey(contact.phone ?? ''),
		email: emailKey(contact.email ?? ''),
		name: nameKey(contact.name)
	};
}

/** Builds the lookup once; asking about a row is then a pass over the existing Workers. */
export function duplicateFinder(existing: readonly ExistingContact[]) {
	const known = existing.map((worker) => ({ worker, keys: keys(worker) }));
	return (contact: Contact): DuplicateSuggestion[] => {
		const incoming = keys(contact);
		const suggestions: DuplicateSuggestion[] = [];
		for (const { worker, keys: held } of known) {
			const reasons = duplicateReasonOrder.filter(
				(reason) => incoming[reason] !== '' && incoming[reason] === held[reason]
			);
			if (reasons.length > 0) {
				suggestions.push({ workerId: worker.id, workerName: worker.name, reasons });
			}
		}
		return suggestions;
	};
}
