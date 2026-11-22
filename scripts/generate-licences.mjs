#!/usr/bin/env node
// Builds the list behind Settings > About > Open-source licences from what the app ships:
// the npm packages the frontend imports (plus their dependencies) and the Cargo crates the
// desktop app links (normal dependencies, macOS targets). Licence texts are grouped, so a text
// shared by many packages is stored once. Email addresses are removed from the texts.
//
// Usage: node scripts/generate-licences.mjs          write src/lib/features/settings/licences.generated.json
//        node scripts/generate-licences.mjs --check  fail when the committed file is out of date
// Needs `npm ci` and a Cargo that can read the registry (`cargo metadata --locked`).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src/lib/features/settings/licences.generated.json');
const CARGO_APP = 'wobble-tauri';
const CARGO_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
/* Packages the build always bundles without an import in src/ naming them. */
const ALWAYS_BUNDLED = ['svelte', '@sveltejs/kit'];
/* Imported by test helpers and the shadcn CSS, never shipped. */
const NOT_SHIPPED = new Set(['vitest', 'vite', 'shadcn-svelte', '@playwright/test']);
/* Native binaries for one operating system differ by machine; the tree must not. */
const PLATFORM_PACKAGE = /-(linux|win32|darwin|freebsd|android|openbsd|sunos)-/;
const LICENCE_FILE = /^(licen[sc]e|copying|unlicense|notice)([-_.].*)?$/i;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/* Text the app shows is third-party and public, but contributor emails need not be copied. */
function cleanText(raw) {
	return raw
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]*<[^<>\s]+@[^<>\s]+>/g, '')
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function readLicenceText(dir, extraFile) {
	const names = new Set();
	for (const entry of readdirSync(dir)) {
		if (LICENCE_FILE.test(entry) && statSync(join(dir, entry)).isFile()) names.add(entry);
	}
	if (extraFile && existsSync(join(dir, extraFile))) names.add(extraFile);
	return [
		...new Set([...names].sort().map((name) => cleanText(readFileSync(join(dir, name), 'utf8'))))
	].filter(Boolean);
}

/* ── npm: the packages src/ imports, and what they depend on ─────────────────── */

function sourceFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'paraglide' && entry.name !== 'generated') out.push(...sourceFiles(path));
		} else if (/\.(ts|svelte|css)$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) {
			out.push(path);
		}
	}
	return out;
}

function importedPackages() {
	const names = new Set(ALWAYS_BUNDLED);
	const spec = /(?:\bfrom\s*|\bimport\s*\(?\s*|@import\s+(?:url\()?)['"]([^'"]+)['"]/g;
	for (const file of [...sourceFiles(join(root, 'src')), join(root, 'src/app.css')]) {
		if (!existsSync(file)) continue;
		const text = readFileSync(file, 'utf8');
		for (const [, specifier] of text.matchAll(spec)) {
			if (/^[./#$]/.test(specifier) || specifier.startsWith('node:')) continue;
			const parts = specifier.split('/');
			names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
		}
	}
	return names;
}

function findPackageDir(name, fromDir) {
	for (let dir = fromDir; ; dir = dirname(dir)) {
		const candidate = join(dir, 'node_modules', name);
		if (existsSync(join(candidate, 'package.json'))) return candidate;
		if (dir === dirname(dir) || dir === root) break;
	}
	const top = join(root, 'node_modules', name);
	return existsSync(join(top, 'package.json')) ? top : null;
}

function npmPackages() {
	const rootManifest = readJson(join(root, 'package.json'));
	const declared = { ...rootManifest.dependencies, ...rootManifest.devDependencies };
	const seen = new Map();
	const queue = [...importedPackages()]
		.filter((name) => name in declared && !NOT_SHIPPED.has(name))
		.map((name) => ({ name, from: root }));
	while (queue.length > 0) {
		const { name, from } = queue.shift();
		const dir = findPackageDir(name, from);
		if (!dir || seen.has(dir) || PLATFORM_PACKAGE.test(name)) continue;
		const manifest = readJson(join(dir, 'package.json'));
		const licence =
			typeof manifest.license === 'string'
				? manifest.license
				: (manifest.license?.type ?? manifest.licenses?.map((l) => l.type).join(' OR ') ?? '');
		seen.set(dir, {
			name: manifest.name,
			version: manifest.version,
			ecosystem: 'npm',
			license: licence || 'Unknown',
			texts: readLicenceText(dir)
		});
		for (const dep of Object.keys({
			...manifest.dependencies,
			...manifest.optionalDependencies
		})) {
			queue.push({ name: dep, from: dir });
		}
	}
	return [...seen.values()];
}

/* ── Cargo: the crates the desktop app links ─────────────────────────────────── */

function cargoPackages() {
	const args = ['metadata', '--format-version', '1', '--locked'];
	for (const target of CARGO_TARGETS) args.push('--filter-platform', target);
	const metadata = JSON.parse(
		execFileSync('cargo', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' })
	);
	const byId = new Map(metadata.packages.map((p) => [p.id, p]));
	const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
	const workspace = new Set(metadata.workspace_members);
	const start = metadata.packages.find((p) => p.name === CARGO_APP);
	if (!start) throw new Error(`generate-licences: no Cargo package named ${CARGO_APP}`);

	const seen = new Set();
	const stack = [start.id];
	while (stack.length > 0) {
		const id = stack.pop();
		if (seen.has(id)) continue;
		seen.add(id);
		for (const dep of nodes.get(id)?.deps ?? []) {
			/* kind null is a normal dependency; build and dev dependencies are not shipped. */
			if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
		}
	}
	return [...seen]
		.filter((id) => !workspace.has(id))
		.map((id) => {
			const pkg = byId.get(id);
			const dir = dirname(pkg.manifest_path);
			return {
				name: pkg.name,
				version: pkg.version,
				ecosystem: 'cargo',
				license: pkg.license ?? 'See licence file',
				texts: readLicenceText(dir, pkg.license_file ?? undefined)
			};
		});
}

/* ── Output: each distinct text once, packages pointing at it ───────────────── */

function build() {
	const texts = {};
	const packages = [...npmPackages(), ...cargoPackages()].map((pkg) => ({
		name: pkg.name,
		version: pkg.version,
		ecosystem: pkg.ecosystem,
		license: pkg.license,
		texts: pkg.texts.map((text) => {
			const id = createHash('sha256').update(text).digest('hex').slice(0, 12);
			texts[id] = text;
			return id;
		})
	}));
	packages.sort(
		(a, b) =>
			a.name.localeCompare(b.name, 'en') ||
			a.version.localeCompare(b.version, 'en') ||
			a.ecosystem.localeCompare(b.ecosystem, 'en')
	);
	const sortedTexts = Object.fromEntries(
		Object.entries(texts).sort(([a], [b]) => a.localeCompare(b))
	);
	return `${JSON.stringify({ count: packages.length, packages, texts: sortedTexts }, null, '\t')}\n`;
}

const next = build();
if (process.argv.includes('--check')) {
	const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
	if (current !== next) {
		console.error(
			'licences: src/lib/features/settings/licences.generated.json is out of date. Run `npm run licences:generate` and commit it.'
		);
		process.exit(1);
	}
	console.log('licences: up to date');
} else {
	writeFileSync(OUT, next);
	console.log(`licences: wrote ${OUT.slice(root.length + 1)}`);
}
