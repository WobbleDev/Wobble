/**
 * Page titles and subtitles by stable route key. Page loads carry the key, not a
 * translated string, so a route can load before the shell has frozen the locale.
 */
import { m } from '#lib/paraglide/messages.js';

const routeCopy = {
	overview: { title: m.page_overview_title, subtitle: m.page_overview_subtitle },
	workers: { title: m.page_workers_title, subtitle: m.page_workers_subtitle },
	mapping: { title: m.page_mapping_title, subtitle: m.page_mapping_subtitle },
	settings: { title: m.page_settings_title },
	configuration: { title: m.page_configuration_title }
} as const;

export type RouteCopyKey = keyof typeof routeCopy;

function isRouteCopyKey(value: unknown): value is RouteCopyKey {
	return typeof value === 'string' && value in routeCopy;
}

export function routeTitle(key: unknown): string {
	return isRouteCopyKey(key) ? routeCopy[key].title() : m.page_application_title();
}

export function routeSubtitle(key: unknown): string {
	if (!isRouteCopyKey(key)) return '';
	const copy = routeCopy[key];
	return 'subtitle' in copy ? copy.subtitle() : '';
}

/** The destination named in a leave prompt, keyed by the route path it goes to. */
export function destinationLabel(pathname: string): string {
	const key: RouteCopyKey | undefined =
		pathname === '/overview'
			? 'overview'
			: pathname === '/workers'
				? 'workers'
				: pathname === '/mapping'
					? 'mapping'
					: pathname === '/settings'
						? 'settings'
						: pathname === '/configuration'
							? 'configuration'
							: undefined;
	return key ? routeCopy[key].title() : pathname;
}
