/**
 * Paraglide compiler settings.
 *
 * The app is a client-rendered SPA with no locale-prefixed routes. The applied locale is
 * resolved once per launch by the shell and written to Paraglide's global variable; a
 * saved preference only changes which locale the *next* launch resolves. The default
 * cookie/localStorage detection is deliberately absent so the document's language can
 * never be changed behind the shell's back.
 */
export default {
	strategy: ['globalVariable', 'baseLocale'],
	emitTsDeclarations: true,
	cleanOutdir: true
};
