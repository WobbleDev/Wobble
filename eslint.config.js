import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	{
		// Nested worktrees, build output and generated artefacts are not project source.
		ignores: [
			'.worktrees/**',
			'.svelte-kit/**',
			'build/**',
			'test-results/**',
			'.playwright-mcp/**',
			'.dsh/**',
			'agent/**',
			'.archify/**',
			// A throwaway UI preview lives under src/ until its spec lands; it is not shipped.
			'src/routes/workers-assignment-preview/**',
			'.scratch/overview-dashboard/reference/**',
			'target/**',
			'src-tauri/gen/**',
			'src-tauri/icons/**',
			'src/lib/paraglide/**'
		]
	},
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		// Vendored shadcn-svelte primitives are generated and kept as upstream ships them.
		ignores: ['src/lib/components/ui/**', 'src/lib/client/generated/**']
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	},
	{
		files: ['src/**/*.{ts,js,svelte}', 'e2e/**/*.{ts,js}'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							// SvelteKit's generated ./$types is virtual and has no extension.
							regex: '^\\.{1,2}/(?!\\$types$)(?!.*\\.(ts|js|svelte|json|css)$).*$',
							message: 'Relative imports name their file extension (.ts, .svelte.ts, .svelte).'
						}
					]
				}
			]
		}
	}
);
