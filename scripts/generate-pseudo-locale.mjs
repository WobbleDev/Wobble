#!/usr/bin/env node
/**
 * Generates the development-only expanded pseudo-locale from the English catalogs.
 *
 * The output is git-ignored and is not a selectable release language. Every message
 * string is wrapped in visible markers and padded so a stress run exercises real
 * message rendering with longer text, rather than only changing `<html lang>`.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const messages = join(root, 'messages');
const out = join(messages, 'en-XA');

function expandText(text) {
	const padding = '·'.repeat(Math.max(2, Math.ceil(text.length * 0.35)));
	return `⟦${text} ${padding}⟧`;
}

function expand(value, key = '') {
	if (typeof value === 'string') {
		if (key === '$schema') return value;
		return expandText(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => expand(item, key));
	}
	if (value && typeof value === 'object') {
		const result = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			if (childKey === '$schema' || childKey === 'declarations' || childKey === 'selectors') {
				result[childKey] = childValue;
			} else if (childKey === 'match' && childValue && typeof childValue === 'object') {
				result[childKey] = Object.fromEntries(
					Object.entries(childValue).map(([variant, text]) => [variant, expandText(text)])
				);
			} else {
				result[childKey] = expand(childValue, childKey);
			}
		}
		return result;
	}
	return value;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const rootCatalog = JSON.parse(readFileSync(join(messages, 'en.json'), 'utf8'));
writeFileSync(join(messages, 'en-XA.json'), JSON.stringify(expand(rootCatalog), null, '\t') + '\n');

for (const file of readdirSync(join(messages, 'en')).filter((name) => name.endsWith('.json'))) {
	const catalog = JSON.parse(readFileSync(join(messages, 'en', file), 'utf8'));
	writeFileSync(join(out, file), JSON.stringify(expand(catalog), null, '\t') + '\n');
}

console.log('Wrote the en-XA pseudo-locale from the English catalogs.');
