/*
 * The open-source licence list behind Settings > About. `licences.generated.json` is written by
 * scripts/generate-licences.mjs from the npm packages the frontend imports and the Cargo crates
 * the desktop app links; CI fails when the committed copy is stale. It is loaded on demand, so the
 * Settings page does not carry roughly 600 KB of licence text until someone opens the list.
 */
export type LicencePackage = {
	name: string;
	version: string;
	ecosystem: 'npm' | 'cargo';
	license: string;
	/** Ids into `texts`; empty when the package ships no licence file. */
	texts: string[];
};

export type LicenceData = {
	count: number;
	packages: LicencePackage[];
	texts: Record<string, string>;
};

export async function loadLicences(): Promise<LicenceData> {
	const module = await import('./licences.generated.json');
	return module.default as LicenceData;
}

/** Every word of the query must appear in the package name or its licence, ignoring case. */
export function filterPackages(packages: LicencePackage[], query: string): LicencePackage[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return packages;
	return packages.filter((pkg) => {
		const haystack = `${pkg.name} ${pkg.version} ${pkg.license}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}
