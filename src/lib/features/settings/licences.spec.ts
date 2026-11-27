import { describe, expect, it } from 'vitest';
import { filterPackages, loadLicences, type LicencePackage } from './licences.ts';

const packages: LicencePackage[] = [
	{ name: 'serde', version: '1.0.0', ecosystem: 'cargo', license: 'MIT OR Apache-2.0', texts: [] },
	{ name: 'svelte', version: '5.0.0', ecosystem: 'npm', license: 'MIT', texts: ['a'] },
	{ name: 'cssparser', version: '0.34.0', ecosystem: 'cargo', license: 'MPL-2.0', texts: ['b'] }
];

describe('filterPackages', () => {
	it('keeps every package for an empty query', () => {
		expect(filterPackages(packages, '  ')).toEqual(packages);
	});

	it('matches the name or the licence, ignoring case', () => {
		expect(filterPackages(packages, 'SVEL').map((p) => p.name)).toEqual(['svelte']);
		expect(filterPackages(packages, 'mpl').map((p) => p.name)).toEqual(['cssparser']);
	});

	it('needs every word', () => {
		expect(filterPackages(packages, 'mit apache').map((p) => p.name)).toEqual(['serde']);
		expect(filterPackages(packages, 'svelte apache')).toEqual([]);
	});
});

describe('generated licence data', () => {
	it('lists the packages the app ships, each text resolvable', async () => {
		const data = await loadLicences();
		expect(data.count).toBe(data.packages.length);
		const names = data.packages.map((p) => p.name);
		expect(names).toContain('svelte');
		expect(names).toContain('tauri');
		for (const pkg of data.packages) {
			expect(pkg.license).not.toBe('');
			for (const id of pkg.texts) expect(data.texts[id]).toBeTruthy();
		}
	});

	it('lists each package once, because the dialog keys its rows by ecosystem, name and version', async () => {
		const data = await loadLicences();
		const keys = data.packages.map((p) => `${p.ecosystem}:${p.name}@${p.version}`);
		expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
	});

	it('keeps email addresses out of the texts', async () => {
		const data = await loadLicences();
		const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
		expect(Object.values(data.texts).filter((text) => email.test(text))).toEqual([]);
	});
});
