// Routing rules for `npm run verify`: which checks a set of changed paths needs.
// Plain module (no I/O) so the rules are specced in verify-routing.spec.ts; the
// runner in verify.mjs does the git and process work.

export type AreaMap = Record<string, string[]>;

export interface RoutingConfig {
	/** e2e/areas.json: area name to spec globs. */
	areas: AreaMap;
	/** e2e/suites.json: isolated suite name to spec globs. */
	suites: AreaMap;
	/** e2e/ui-specs.ts: the globs of the specs the `ui` suite replays. */
	uiSpecs: string[];
}

export interface Selection {
	/** Run `npm run test:rust`. */
	rust: boolean;
	/** Playwright areas to run (sorted). */
	areas: string[];
	/** Isolated Playwright suites that own specs in the selected areas (sorted). */
	isolatedSuites: string[];
	/** Run the `ui` suite (replayed responses). */
	ui: boolean;
	/** Shared frontend code changed and no area runs: run the `@smoke` subset. */
	smoke: boolean;
	/** Why each non-trivial decision was made, for the evidence record. */
	reasons: string[];
}

/** Isolated suites e2e-all.sh runs by default, in its order. */
export const defaultIsolatedSuites = [
	'boot-lifecycle',
	'onboarding',
	'settings',
	'delete-worksite',
	'no-scroll-density',
	'mapping'
];

/** A glob over an `e2e/` file name as a regex; a leading `**` matches any directory. */
export function globToRegExp(glob: string): RegExp {
	return new RegExp(
		`^${glob
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replaceAll('**/', '(?:.*/)?')
			.replaceAll('*', '[^/]*')}$`
	);
}

/** The areas whose globs match an `e2e/` file name. */
export function areasOfSpec(file: string, areas: AreaMap): string[] {
	return Object.entries(areas)
		.filter(([, globs]) => globs.some((glob) => globToRegExp(glob).test(file)))
		.map(([area]) => area);
}

type Route = { kind: 'none' } | { kind: 'area'; area: string };

const featureDirs: Record<string, string> = {
	mapping: 'mapping',
	overview: 'overview',
	configuration: 'configuration',
	workers: 'workers',
	settings: 'settings-ui'
};

/** Paths that change what the `ui` suite replays or how it replays it. */
const isUiPath = (path: string, uiSpecs: string[]) =>
	/^e2e\/(ui-specs\.ts|fixtures\.ts|replay-recordings\.ts|recordings\/.*)$/.test(path) ||
	/^src\/lib\/(client|contract)\//.test(path) ||
	(/^e2e\/[^/]+\.spec\.ts$/.test(path) &&
		uiSpecs.some((glob) => globToRegExp(glob).test(path.slice('e2e/'.length))));

/** Shared frontend code no single area owns. */
const isSharedPath = (path: string) =>
	/^src\/lib\/(components|shared)\//.test(path) ||
	/^src\/lib\/domain-vocabulary\.ts$/.test(path) ||
	/^src\/app\.(html|css)$/.test(path);

const isRustPath = (path: string) => /\.rs$/.test(path) || /(^|\/)Cargo\.(toml|lock)$/.test(path);

function routePath(path: string, config: RoutingConfig): Route {
	if (path.startsWith('.scratch/') || path.startsWith('docs/') || path.endsWith('.md')) {
		return { kind: 'none' };
	}
	// Unit specs and the verify tooling are proven by `npm test` and `npm run lint`.
	if (/^src\/.*\.spec\.ts$/.test(path) || path.startsWith('src/lib/testing/')) {
		return { kind: 'none' };
	}
	if (/^scripts\/verify[\w.-]*$/.test(path)) return { kind: 'none' };
	if (path.startsWith('e2e/')) {
		const file = path.slice('e2e/'.length);
		if (/^[^/]+\.spec\.ts$/.test(file)) {
			const owners = areasOfSpec(file, config.areas);
			if (owners.length === 1) return { kind: 'area', area: owners[0] };
		}
		return { kind: 'none' };
	}
	const feature = /^src\/(?:lib\/features|routes)\/([^/]+)\//.exec(path)?.[1];
	if (feature && feature in featureDirs) return { kind: 'area', area: featureDirs[feature] };
	if (path.startsWith('src/lib/shell/') || /^src\/routes\/[^/]+$/.test(path)) {
		return { kind: 'area', area: 'shared-shell' };
	}
	// Config, helpers and unknown paths select no browser work: the nightly run covers them.
	return { kind: 'none' };
}

/** The checks beyond lint, check and test that a set of changed paths needs. */
export function routeChanges(paths: string[], config: RoutingConfig): Selection {
	const areas = new Set<string>();
	const reasons: string[] = [];
	let rust = false;
	let ui = false;
	let shared = false;
	for (const path of paths) {
		if (isUiPath(path, config.uiSpecs)) {
			ui = true;
			if (!reasons.includes('ui suite inputs changed')) reasons.push('ui suite inputs changed');
		}
		if (isRustPath(path)) {
			rust = true;
			if (!reasons.includes('Rust or Cargo files changed')) {
				reasons.push('Rust or Cargo files changed');
			}
		}
		const route = routePath(path, config);
		if (route.kind === 'area') {
			areas.add(route.area);
		} else if (isSharedPath(path) && !/^src\/.*\.spec\.ts$/.test(path)) {
			shared = true;
		}
	}
	const selected = [...areas].sort();
	// no-scroll-density checks every page at each density, so any UI area schedules it.
	const isolatedSuites = defaultIsolatedSuites.filter(
		(suite) =>
			(suite === 'no-scroll-density' && selected.length > 0) ||
			(config.suites[suite] ?? []).some((glob) =>
				areasOfSpec(glob.replace(/^\*\*\//, ''), config.areas).some((area) =>
					selected.includes(area)
				)
			)
	);
	// The ui specs leave the regular suite, so an area that owns one is paired with the ui run.
	const uiOwners = selected.filter((area) =>
		config.uiSpecs.some((glob) =>
			areasOfSpec(glob.replace(/^\*\*\//, ''), config.areas).includes(area)
		)
	);
	if (uiOwners.length > 0) reasons.push(`area owns ui specs: ${uiOwners.join(', ')}`);
	const smoke = shared && selected.length === 0;
	if (smoke) reasons.push('shared frontend code changed: @smoke subset');
	return {
		rust,
		areas: selected,
		isolatedSuites,
		ui: ui || uiOwners.length > 0,
		smoke,
		reasons
	};
}

export interface CheckPlan {
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
}

/** Lint, check and test always; then Rust and Playwright as selected. Sequential. */
export function planChecks(selection: Selection, port: string): CheckPlan[] {
	const plan: CheckPlan[] = ['lint', 'check', 'test'].map((script) => ({
		name: script,
		command: 'npm',
		args: ['run', script],
		env: {}
	}));
	if (selection.rust) {
		plan.push({ name: 'test:rust', command: 'npm', args: ['run', 'test:rust'], env: {} });
	}
	if (selection.smoke) {
		plan.push({
			name: 'e2e:smoke',
			command: 'scripts/e2e-all.sh',
			args: ['regular'],
			env: { WOBBLE_E2E_PORT: port, WOBBLE_E2E_GREP: '@smoke' }
		});
	}
	const suites = [
		...(selection.areas.length > 0 ? ['regular', ...selection.isolatedSuites] : []),
		...(selection.ui ? ['ui'] : [])
	];
	if (suites.length > 0) {
		plan.push({
			name: selection.areas.length > 0 ? `e2e:${selection.areas.join('+')}` : 'e2e:ui',
			command: 'scripts/e2e-all.sh',
			args: suites,
			env: {
				WOBBLE_E2E_PORT: port,
				...(selection.areas.length > 0 ? { WOBBLE_E2E_AREA: selection.areas.join(',') } : {})
			}
		});
	}
	return plan;
}
