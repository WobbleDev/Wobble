import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The app's global stylesheet as one text: `src/routes/layout.css` with each local
 * `@import './styles/...'` replaced, in order, by that file's content. Specs that pin a rule or
 * token read this instead of one file, so moving a rule between the per-area stylesheets
 * does not change what they see.
 */
export function readLayoutCss(entry = resolve('src/routes/layout.css')): string {
	const text = readFileSync(entry, 'utf8');
	return text.replace(/^@import '(\.[^']+)';\n?/gm, (_, path: string) =>
		readLayoutCss(resolve(dirname(entry), path))
	);
}
