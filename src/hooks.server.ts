/**
 * Injects the pre-framework splash copy from the same catalogs the app uses.
 *
 * The document is static and client-rendered, so this runs while SvelteKit writes the
 * fallback index.html. The inline script in app.html picks one locale out of the small
 * blob before the app bundles load; it reads only this copy and the startup hint, never
 * Worker content.
 */
import type { Handle } from '@sveltejs/kit/hooks';
import { m } from '#lib/paraglide/messages.js';

const splashCopy = {
	en: {
		loading: m.splash_loading({}, { locale: 'en' }),
		stillLoading: m.splash_still_loading({}, { locale: 'en' }),
		phrases: [
			m.splash_phrase_1({}, { locale: 'en' }),
			m.splash_phrase_2({}, { locale: 'en' }),
			m.splash_phrase_3({}, { locale: 'en' }),
			m.splash_phrase_4({}, { locale: 'en' }),
			m.splash_phrase_5({}, { locale: 'en' })
		]
	},
	'es-419': {
		loading: m.splash_loading({}, { locale: 'es-419' }),
		stillLoading: m.splash_still_loading({}, { locale: 'es-419' }),
		phrases: [
			m.splash_phrase_1({}, { locale: 'es-419' }),
			m.splash_phrase_2({}, { locale: 'es-419' }),
			m.splash_phrase_3({}, { locale: 'es-419' }),
			m.splash_phrase_4({}, { locale: 'es-419' }),
			m.splash_phrase_5({}, { locale: 'es-419' })
		]
	}
};

/* The blob is embedded in a script element: a literal "</script>" would end it early. */
const splashJson = JSON.stringify(splashCopy).replaceAll('<', '\\u003c');

export const handle: Handle = ({ event, resolve }) =>
	resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%wobble.splash%', splashJson)
	});
