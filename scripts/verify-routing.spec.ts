import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { areasOfSpec, planChecks, routeChanges, type RoutingConfig } from './verify-routing.ts';

const config: RoutingConfig = {
	areas: JSON.parse(readFileSync('e2e/areas.json', 'utf8')),
	suites: JSON.parse(readFileSync('e2e/suites.json', 'utf8')),
	uiSpecs: ['**/overview-default.spec.ts', '**/mapping-table.spec.ts']
};
const route = (...paths: string[]) => routeChanges(paths, config);

describe('e2e area assignment', () => {
	it('puts every spec in exactly one area', () => {
		const specs = readdirSync('e2e').filter((file) => file.endsWith('.spec.ts'));
		const unassigned = specs.filter((file) => areasOfSpec(file, config.areas).length !== 1);
		expect(specs.length).toBeGreaterThan(0);
		expect(unassigned).toEqual([]);
	});

	it('keeps every isolated suite spec inside a single area', () => {
		for (const globs of Object.values(config.suites)) {
			for (const glob of globs) {
				expect(areasOfSpec(glob.replace('**/', ''), config.areas)).toHaveLength(1);
			}
		}
	});
});

describe('routeChanges', () => {
	it('adds nothing for documentation, scratch files and unit specs', () => {
		const selection = route('AGENTS.md', '.scratch/x/y.md', 'src/lib/shared/text.spec.ts');
		expect(selection).toMatchObject({ rust: false, areas: [], isolatedSuites: [], ui: false });
	});

	it('adds Rust checks for Rust and Cargo files and selects no browser work', () => {
		expect(route('crates/wobble-core/src/lib.rs')).toMatchObject({
			rust: true,
			areas: [],
			isolatedSuites: []
		});
		expect(route('Cargo.lock')).toMatchObject({ rust: true, areas: [] });
	});

	it('selects only the feature area for a feature change', () => {
		const selection = route('src/lib/features/overview/bullseye.ts');
		expect(selection.areas).toEqual(['overview']);
	});

	it('selects nothing for a markdown change', () => {
		expect(route('docs/agents/testing.md', 'README.md')).toMatchObject({
			areas: [],
			isolatedSuites: []
		});
	});

	it('maps a settings change to the settings suites', () => {
		const selection = route('src/routes/settings/+page.svelte');
		expect(selection.areas).toEqual(['settings-ui']);
		expect(selection.isolatedSuites).toEqual(['settings', 'no-scroll-density']);
	});

	it.each([
		['src/lib/features/overview/bullseye.ts'],
		['src/lib/features/workers/x.ts'],
		['src/lib/shell/navigation-rail.svelte']
	])('schedules no-scroll-density for any selected UI area: %s', (path) => {
		expect(route(path).isolatedSuites).toContain('no-scroll-density');
	});

	it('maps a spec to its own area', () => {
		expect(route('e2e/overview-bullseye.spec.ts').areas).toEqual(['overview']);
		expect(route('e2e/create-first-worksite.spec.ts')).toMatchObject({
			areas: ['persistence'],
			isolatedSuites: ['onboarding', 'delete-worksite', 'no-scroll-density']
		});
	});

	it('maps the shell to the shared-shell area', () => {
		expect(route('src/lib/shell/navigation-rail.svelte').areas).toEqual(['shared-shell']);
	});

	it.each([
		['src/lib/i18n/index.ts'],
		['messages/en.json'],
		['static/icon.svg'],
		['playwright.config.ts'],
		['package.json'],
		['e2e/areas.json'],
		['somewhere/unknown.txt']
	])('selects no browser work for %s', (path) => {
		expect(route(path)).toMatchObject({ areas: [], isolatedSuites: [] });
	});

	it.each([
		['src/lib/client/transport.ts'],
		['src/lib/contract/recordings.spec.ts'],
		['e2e/fixtures.ts'],
		['e2e/ui-specs.ts'],
		['e2e/replay-recordings.ts'],
		['e2e/recordings/overview-default/x.json'],
		['e2e/overview-default.spec.ts']
	])('selects the ui suite for %s', (path) => {
		expect(route(path).ui).toBe(true);
	});

	it('pairs a run with the ui suite only when the area owns a ui spec', () => {
		const selection = route('src/lib/features/mapping/x.ts');
		expect(selection.ui).toBe(true);
		expect(selection.reasons).toContain('area owns ui specs: mapping');
		expect(route('src/lib/features/workers/x.ts')).toMatchObject({ areas: ['workers'], ui: false });
		expect(route('src/lib/shared/text.ts').ui).toBe(false);
	});

	it('does not repeat the ui reason when its inputs changed', () => {
		const selection = route('e2e/fixtures.ts');
		expect(selection.ui).toBe(true);
		expect(selection.reasons).toEqual(['ui suite inputs changed']);
	});

	it.each([
		['src/lib/domain-vocabulary.ts'],
		['src/lib/components/ui/button/button.svelte'],
		['src/lib/shared/text.ts'],
		['src/app.html'],
		['src/app.css']
	])('selects the smoke subset for shared code %s', (path) => {
		const selection = route(path);
		expect(selection).toMatchObject({ smoke: true, areas: [], isolatedSuites: [] });
		expect(selection.reasons).toContain('shared frontend code changed: @smoke subset');
	});

	it('skips smoke when an area runs, or for a unit spec or other paths', () => {
		expect(route('src/lib/shared/text.ts', 'src/lib/features/overview/x.ts').smoke).toBe(false);
		expect(route('src/lib/shared/text.spec.ts').smoke).toBe(false);
		expect(route('src/lib/i18n/index.ts').smoke).toBe(false);
	});

	it('runs the serial mapping suite for a mapping change', () => {
		expect(route('src/lib/features/mapping/x.ts').isolatedSuites).toEqual([
			'no-scroll-density',
			'mapping'
		]);
		expect(route('e2e/mapping-touch.spec.ts').isolatedSuites).toEqual([
			'no-scroll-density',
			'mapping'
		]);
	});

	it('combines areas and keeps Rust separate from the full set', () => {
		const selection = route(
			'src/lib/features/workers/x.ts',
			'src/lib/features/overview/y.ts',
			'a.rs'
		);
		expect(selection.rust).toBe(true);
		expect(selection.areas).toEqual(['overview', 'workers']);
	});
});

describe('planChecks', () => {
	const names = (selection: ReturnType<typeof route>) =>
		planChecks(selection, '1234').map((check) => check.name);

	it('always runs lint, check and test in order', () => {
		expect(names(route('AGENTS.md'))).toEqual(['lint', 'check', 'test']);
	});

	it('runs only the ui suite when only its inputs changed', () => {
		const plan = planChecks(route('src/lib/client/transport.ts'), '1234');
		expect(plan[plan.length - 1]).toMatchObject({ name: 'e2e:ui', args: ['ui'] });
	});

	it('adds Rust, then the narrowed browser run with its area filter', () => {
		const plan = planChecks(route('a.rs', 'src/lib/features/mapping/x.ts'), '1234');
		expect(plan.map((check) => check.name)).toEqual([
			'lint',
			'check',
			'test',
			'test:rust',
			'e2e:mapping'
		]);
		const e2e = plan[plan.length - 1];
		expect(e2e.args).toEqual(['regular', 'no-scroll-density', 'mapping', 'ui']);
		expect(e2e.env).toEqual({ WOBBLE_E2E_PORT: '1234', WOBBLE_E2E_AREA: 'mapping' });
	});

	it('runs the @smoke subset of the regular suite for shared code', () => {
		const plan = planChecks(route('src/lib/shared/text.ts'), '1234');
		expect(plan[plan.length - 1]).toMatchObject({
			name: 'e2e:smoke',
			command: 'scripts/e2e-all.sh',
			args: ['regular'],
			env: { WOBBLE_E2E_PORT: '1234', WOBBLE_E2E_GREP: '@smoke' }
		});
	});
});
