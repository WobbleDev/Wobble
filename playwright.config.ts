import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
// The suite-to-spec map is shared with scripts/check-e2e-settings-writes.mjs, so the two
// cannot disagree about which specs are isolated.
import suiteSpecs from './e2e/suites.json' with { type: 'json' };

import { uiSpecs } from './e2e/ui-specs.ts';
import areaSpecs from './e2e/areas.json' with { type: 'json' };

const suite = process.env.WOBBLE_E2E_SUITE ?? 'regular';
const knownSuites = ['regular', 'ui', ...Object.keys(suiteSpecs)] as const;
if (!(knownSuites as readonly string[]).includes(suite)) {
	throw new Error(`Unknown WOBBLE_E2E_SUITE "${suite}". Use one of: ${knownSuites.join(', ')}.`);
}
// WOBBLE_E2E_AREA=mapping,overview narrows the regular suite to those areas (e2e/areas.json
// assigns every spec to exactly one area; the per-area runs add up to the full suite).
// Isolated suites ignore it. `--grep @smoke` selects the smoke subset.
const areas = (process.env.WOBBLE_E2E_AREA ?? '').split(',').filter(Boolean);
for (const area of areas) {
	if (!(area in areaSpecs)) {
		throw new Error(
			`Unknown WOBBLE_E2E_AREA "${area}". Use one of: ${Object.keys(areaSpecs).join(', ')}.`
		);
	}
}
// WOBBLE_E2E_GREP=@smoke narrows by test tag (the launcher passes it through).
const grep = process.env.WOBBLE_E2E_GREP ? new RegExp(process.env.WOBBLE_E2E_GREP) : undefined;
// `@flaky` tests are out of the gate; WOBBLE_E2E_FLAKY=1 runs only them (`npm run test:e2e:flaky`).
const flakyOnly = process.env.WOBBLE_E2E_FLAKY === '1';
const areaMatch = areas.flatMap((area) => areaSpecs[area as keyof typeof areaSpecs]);
// WebKit is opt-in (`npm run test:e2e:webkit`): it doubles the `regular` suite, so it runs
// before merging rather than after every change.
const includeWebkit = process.env.WOBBLE_E2E_WEBKIT === '1';
const databasePath =
	process.env.WOBBLE_E2E_DB ??
	join(
		tmpdir(),
		`wobble-e2e-${basename(process.cwd())}-${includeWebkit ? 'webkit' : suite}.sqlite`
	);
const isolatedSpecs = Object.values(suiteSpecs).flat();
// With WebKit the mapping specs stay in `regular` for WebKit only; the chromium project
// skips them because the serial `mapping` suite owns them there.
const mappingSpecs = suiteSpecs.mapping;
const regularIgnored = includeWebkit
	? isolatedSpecs.filter((spec) => !mappingSpecs.includes(spec))
	: isolatedSpecs;
const selectedSpec = suiteSpecs[suite as keyof typeof suiteSpecs];
const port = process.env.WOBBLE_E2E_PORT ?? '4173';
const isRegular = suite === 'regular';
const runDir = process.env.WOBBLE_E2E_RUN_DIR;
const suiteDir = runDir ? join(runDir, suite) : undefined;

// `mapping-touch` emulates touch through Chrome DevTools Protocol, which WebKit does not
// have ("CDP session is only available in Chromium"), so the `regular` suite runs it on
// Chromium only, like the four state-owning suites.
const webkitIgnoredSpecs = [...regularIgnored, '**/mapping-touch.spec.ts'];

const isUi = suite === 'ui';
const uiPort = process.env.WOBBLE_E2E_PORT ?? '4174';

export default defineConfig({
	testDir: './e2e',
	// 23 specs at one worker and 15 s each fit in 10 min.
	...(suite === 'mapping' ? { timeout: 15_000, globalTimeout: 600_000 } : {}),
	testMatch: isUi ? uiSpecs : (selectedSpec ?? (areaMatch.length > 0 ? areaMatch : '**/*.spec.ts')),
	...(isRegular
		? { testIgnore: [...regularIgnored, ...(process.env.WOBBLE_E2E_RECORD === '1' ? [] : uiSpecs)] }
		: {}),
	...(flakyOnly ? { grep: /@flaky/ } : { ...(grep ? { grep } : {}), grepInvert: /@flaky/ }),
	fullyParallel: true,
	// `regular` gives each test its own Worksite on the one shim and `ui` has no database, so
	// both run side by side; the state-owning suites stay one at a time. Three regular workers
	// load an 8 GB, 8-core machine past what the map timing tests tolerate; `ui` has no shim
	// but its map replays still time out on the 3-vCPU macOS runner, so CI uses two.
	workers: Number(
		process.env.WOBBLE_E2E_WORKERS ?? (isUi ? (process.env.CI ? 2 : 3) : isRegular ? 2 : 1)
	),
	retries: 0,
	forbidOnly: true,
	...(suiteDir ? { outputDir: join(suiteDir, 'test-results') } : {}),
	reporter: suiteDir
		? [['list'], ['json', { outputFile: join(suiteDir, 'results.json') }]]
		: 'list',
	use: {
		baseURL: `http://127.0.0.1:${isUi ? uiPort : port}`,
		trace: 'retain-on-failure'
	},
	// The suites drive the Rust core: `npm run build` produces the static SPA and the dev
	// shim serves it together with `handle()` on the one origin the client fetches from.
	webServer: isUi
		? {
				// The `ui` suite answers `/api/` from recordings: serve the static SPA (adapter-static
				// writes `index.html` as the fallback for deep links) with no Rust core.
				command: `npm run build && npx vite preview --host 127.0.0.1 --port ${uiPort} --strictPort`,
				url: `http://127.0.0.1:${uiPort}/workers`,
				reuseExistingServer: false,
				timeout: Number(process.env.WOBBLE_E2E_SERVER_TIMEOUT ?? 300_000)
			}
		: {
				command: `rm -f "${databasePath}" "${databasePath}-shm" "${databasePath}-wal" "${databasePath}-journal" && npm run build && WOBBLE_DB_PATH="${databasePath}" WOBBLE_SHIM_PORT=${port} WOBBLE_STATIC_DIR=build cargo run -p wobble-dev-shim`,
				url: `http://127.0.0.1:${port}/workers`,
				// `scripts/e2e-server.sh` serves a prebuilt app; set WOBBLE_E2E_REUSE=1 to use it.
				reuseExistingServer: process.env.WOBBLE_E2E_REUSE === '1',
				timeout: Number(process.env.WOBBLE_E2E_SERVER_TIMEOUT ?? 300_000)
			},
	projects: isUi
		? [{ name: 'ui', use: { ...devices['Desktop Chrome'] } }]
		: [
				{
					name: 'chromium',
					use: { ...devices['Desktop Chrome'] },
					...(includeWebkit && isRegular ? { testIgnore: mappingSpecs } : {})
				},
				...(includeWebkit
					? [
							{
								name: 'webkit',
								use: { ...devices['Desktop Safari'] },
								// Only the `regular` suite runs on WebKit (D02); the four state-owning suites —
								// and the CDP-driven touch suite — stay Chromium-only.
								testIgnore: isRegular ? webkitIgnoredSpecs : '**/*'
							}
						]
					: [])
			]
});
