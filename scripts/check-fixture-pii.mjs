#!/usr/bin/env node
// Fails when tracked fixtures, recordings, tests or sample data hold personal-data-looking
// patterns: non-example email addresses, real-looking phone numbers, street addresses.
// Prints file:line and a category only, never the matched text (this repo is public).
// Synthetic values to use instead: name@example.com, 555-01xx numbers (e.g. 555-555-0123),
// UK Ofcom drama ranges (+44 20 7946 0xxx), and made-up streets only in prose, not as "12 Name Street".
// Usage: node scripts/check-fixture-pii.mjs [dir ...]   (defaults to the dirs below)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_DIRS = ['src', 'e2e', 'crates', 'contract', 'messages', 'docs', 'static', 'scripts'];
const SKIP_FILE =
	/\.(png|jpe?g|gif|webp|ico|icns|woff2?|ttf|zip|gz)$|(^|\/)(package-lock\.json|Cargo\.lock)$|^scripts\/check-fixture-pii\.mjs$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const SAFE_EMAIL_DOMAIN = new RegExp(
	[
		'(^|\\.)example\\.(com|org|net|test)(?!\\.)', // example.com, and text glued on in binary DBs
		'\\.(test|invalid|example|localhost)$',
		'^localhost$',
		'(^|\\.)noreply\\.github\\.com$',
		'^[a-z]\\.(com|test)$', // x.com style placeholders
		'\\.(png|jpe?g|gif|webp|svg|ico|avif|ts|js|mjs|json|css)$' // asset names like icon@2x.png
	].join('|'),
	'i'
);
const PHONE_NANP = /(?<![\w.])(?:\+?1[ .-])?\(?([2-9]\d{2})\)?[ .-](\d{3})[ .-](\d{4})(?![\w])/g;
const PHONE_INTL = /(?<![\w.])\+\d{1,3}[ .-]?\(?\d{1,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\w])/g;
const ADDRESS =
	/\b\d{1,5} (?:[NSEW]\.? )?[A-Z][a-z]+(?: [A-Z][a-z]+)? (?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl)\b/g;

const fictionalNanp = (area, exch, line) =>
	area === '555' ||
	(exch === '555' && /^01\d\d$/.test(line)) ||
	/^(\d)\1+$/.test(area + exch + line) ||
	area + exch + line === '1234567890';
const fictionalIntl = (digits) =>
	digits.includes('555') ||
	/^(44207946|447700900|441632960|441174960|441914980|44113496|441214960)/.test(digits) ||
	/^(\d)\1+$/.test(digits);

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_DIRS;
const files = execFileSync('git', ['ls-files', '-z', '--', ...dirs], { encoding: 'utf8' })
	.split('\0')
	.filter((f) => f && !SKIP_FILE.test(f));

const hits = new Map(); // "file\tcategory" -> lines
const add = (file, category, line) => {
	const key = `${file}\t${category}`;
	if (!hits.has(key)) hits.set(key, []);
	hits.get(key).push(line);
};

for (const file of files) {
	let buf;
	try {
		buf = readFileSync(file);
	} catch {
		continue;
	}
	// Binary files (SQLite fixtures): scan the printable runs.
	const text = buf.includes(0)
		? buf.toString('latin1').replace(/[^\x20-\x7e\n]+/g, '\n')
		: buf.toString('utf8');
	text.split('\n').forEach((line, i) => {
		const n = i + 1;
		for (const m of line.matchAll(EMAIL)) {
			if (!SAFE_EMAIL_DOMAIN.test(m[1])) add(file, 'email', n);
		}
		for (const m of line.matchAll(PHONE_NANP)) {
			if (!fictionalNanp(m[1], m[2], m[3])) add(file, 'phone', n);
		}
		for (const m of line.matchAll(PHONE_INTL)) {
			if (!fictionalIntl(m[0].replace(/\D/g, ''))) add(file, 'phone', n);
		}
		if (ADDRESS.test(line)) add(file, 'street-address', n);
		ADDRESS.lastIndex = 0;
	});
}

if (hits.size > 0) {
	for (const [key, lines] of hits) {
		const [file, category] = key.split('\t');
		const shown = [...new Set(lines)].slice(0, 8).join(',');
		console.error(`${file}: ${category} pattern, ${lines.length} hit(s), lines ${shown}`);
	}
	console.error(
		`fixture-pii: ${hits.size} file/category group(s) flagged. Matched text is intentionally not printed.\n` +
			'Use example.com/example.org emails and 555-01xx phone numbers in fixtures and tests.'
	);
	process.exit(1);
}
console.log(`fixture-pii: clean (${files.length} files scanned)`);
