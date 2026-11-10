import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
	const { worksite, boot } = await parent();
	if (boot.state !== 'open') return { titleKey: 'configuration', worksite: null };
	if (!worksite) redirect(303, '/overview');

	return {
		titleKey: 'configuration',
		worksite
	};
};
