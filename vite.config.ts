import { defineConfig } from 'vitest/config';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

// Unit specs that take a second or more (500-Worker layouts and the like). They run in
// their own `heavy` project, one file at a time with a generous timeout, so they never
// race the fast specs for CPU and trip a wall-clock timeout.
const heavySpecs = [
	'src/lib/features/mapping/graph-arrangement.spec.ts',
	'src/lib/features/mapping/composition/graph-composition.spec.ts',
	'src/lib/features/mapping/graph-layout-answer-independence.spec.ts',
	'src/lib/features/mapping/graph-layout-quality-baseline.spec.ts',
	'src/lib/features/mapping/graph-free-physics.spec.ts',
	'src/lib/features/mapping/graph-stress.spec.ts',
	'src/lib/features/overview/bullseye/bullseye-lanes.spec.ts'
];

export default defineConfig({
	plugins: [
		tailwindcss(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			strategy: ['globalVariable', 'baseLocale'],
			emitTsDeclarations: true
		}),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// The app is a client-rendered SPA (`+layout.ts` sets `ssr = false`), so the build
			// is static files plus an `index.html` fallback for every deep link; the dev shim
			// serves both.
			adapter: adapter({ fallback: 'index.html' })
		})
	],
	// Dev only. Packages the app imports lazily are invisible to Vite's start-up crawl:
	// the first page to load one made Vite bundle it and reload the whole window. Bundle
	// them up front instead. Warm-up compiles the routes at start, so the first visit
	// to a page does not wait on its modules compiling.
	optimizeDeps: {
		include: [
			'@tauri-apps/api/core',
			'@tauri-apps/api/event',
			'@tauri-apps/api/window',
			'@tauri-apps/plugin-dialog',
			'papaparse'
		]
	},
	server: {
		// Tauri's devUrl is fixed at 5173; fail loudly rather than drift to another port
		// and leave the window blank.
		port: 5173,
		strictPort: true,
		// A browser on the dev server has no Rust core of its own; `/api` goes to the dev shim
		// (`cargo run -p wobble-dev-shim`). Inside Tauri the client uses IPC and never fetches this.
		proxy: { '/api': `http://127.0.0.1:${process.env.WOBBLE_SHIM_PORT ?? 4173}` },
		warmup: {
			clientFiles: ['./src/routes/**/+layout.svelte', './src/routes/**/+page.svelte']
		}
	},
	test: {
		expect: { requireAssertions: true },
		// A spec joins a tag with a `// @module-tag <name>` comment, so `vitest --tags-filter`
		// selects it without a hard-coded file list.
		tags: [
			{ name: 'mapping', description: 'Mapping feature unit specs (npm run test:mapping:unit)' }
		],
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}', 'scripts/**/*.spec.ts'],
					exclude: [...heavySpecs]
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'heavy',
					environment: 'node',
					include: heavySpecs,
					fileParallelism: false,
					testTimeout: 120_000
				}
			}
		]
	}
});
