import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { createWorksite } from '#lib/client/worksite-api.ts';
import { appliedLocale } from '#lib/i18n/locale.ts';
import { m } from '#lib/paraglide/messages.js';
import { withQuery } from '#lib/shared/navigation.ts';

/**
 * Creating the install's first Worksite from the empty shell, then opening the
 * Overview with its setup dialog. Holds the in-flight and error state the empty
 * shell's button shows.
 */
export function createFirstWorksiteSetup() {
	let creating = $state(false);
	let error = $state('');

	async function create(): Promise<void> {
		if (creating) return;

		creating = true;
		error = '';
		try {
			await createWorksite(appliedLocale());
			await goto(withQuery(resolve('/overview'), { setup: '1' }), { invalidateAll: true });
		} catch (caught) {
			error = caught instanceof Error ? caught.message : m.onboarding_create_failed();
		} finally {
			creating = false;
		}
	}

	return {
		get creating() {
			return creating;
		},
		get error() {
			return error;
		},
		create
	};
}
