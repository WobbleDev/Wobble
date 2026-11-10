import { readdirSync, readFileSync } from 'node:fs';

const suites = JSON.parse(readFileSync('e2e/suites.json', 'utf8'));

/** A suite glob as a regex over an `e2e/` file name: a leading `**` matches any directory. */
const globToRegExp = (glob) =>
	new RegExp(
		`^${glob
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replaceAll('**/', '(?:.*/)?')
			.replaceAll('*', '[^/]*')}$`
	);

// Every suite except `mapping` is isolated, so its specs may write settings. The Playwright
// config reads the same file, so the two cannot disagree.
const isolated = Object.entries(suites)
	.filter(([name]) => name !== 'mapping')
	.flatMap(([, specs]) => specs.map(globToRegExp));

let failed = false;
for (const file of readdirSync('e2e')) {
	if (!file.endsWith('.spec.ts') || isolated.some((pattern) => pattern.test(file))) continue;
	const source = readFileSync(`e2e/${file}`, 'utf8');
	// Keep settings, Restore and Erase requests in state-owning suites, including
	// writes via fetch, an aliased request helper, or a raw route string. Regular
	// specs emulate appearance per page.
	if (/api\/(settings|restore|erase)/.test(source)) {
		console.error(
			`e2e/${file}: settings, Restore and Erase requests belong in isolated suites; use page.emulateMedia for themes or set the root attributes directly.`
		);
		failed = true;
	}
}
if (failed) process.exitCode = 1;
