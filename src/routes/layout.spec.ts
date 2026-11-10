import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The eleven named grayscale stops still carry --data-other and every direct
// stop reference, and this file still pins the ramp's shape. What changed at
// ticket 02 (cool Vellum tokens): the sixteen chrome roles are approved cool
// literals declared once per theme, not ramp aliases — so the relationships
// that now matter are that every role exists in both themes and the theme
// still moves it, that the risk-axis pairs keep their measured contrast, and
// that the six material roles and the glass utility ship as specified.
const css = readFileSync(new URL('./layout.css', import.meta.url), 'utf8');

// A role name can be declared twice, once in :root and once in the dark
// override, and the dark declaration is the one that holds there, so the block
// is part of the lookup rather than an afterthought.
function blockAt(selector: string): string {
	const start = css.indexOf(`${selector} {`);
	if (start === -1) throw new Error(`layout.css has no ${selector} block.`);

	let depth = 0;
	for (let index = css.indexOf('{', start); index < css.length; index += 1) {
		if (css[index] === '{') depth += 1;
		else if (css[index] === '}') {
			depth -= 1;
			if (depth === 0) return css.slice(start, index + 1);
		}
	}
	throw new Error(`layout.css has an unbalanced ${selector} block.`);
}

const root = blockAt(':root');
const dark = blockAt('.dark');

function declaredIn(block: string, name: string): string | undefined {
	// The colon anchors the name: `--z1:` never matches `--z10:`.
	return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1].trim();
}

/** The eleven named stops of the ramp. */
const rampStops = ['z0', 'z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7', 'z8', 'z9', 'z10'];

/** The sixteen cool semantic roles. Replaces the old `chromeRoles` stop-alias
 *  list: the roles carry approved cool literals now, so each must exist in
 *  both themes and differ between them (ticket 02). `--data-other` is not
 *  here — it still reads a ramp stop by decision. */
const vellumRoles = [
	'page',
	'panel',
	'inset',
	'nav',
	'hover',
	'toolbar',
	'ink',
	'ink-2',
	'ink-3',
	'ink-inverse',
	'rule',
	'rule-strong',
	'action',
	'action-hover',
	'on-action',
	'focus'
];

/** The six shared material roles, declared in both themes. */
const materialRoles = [
	'surface-glass',
	'surface-glass-solid',
	'surface-blur',
	'surface-shadow',
	'rail-shadow',
	'wash'
];

/** The six Assessment hues, one per standing. */
const assessmentNames = [
	'assess-unassessed',
	'assess-leader',
	'assess-activist',
	'assess-supporter',
	'assess-disengaged',
	'assess-hostile'
];

const lightnessOf = (value: string) => Number(/oklch\(([\d.]+)/.exec(value)?.[1]);

/** Six-digit sRGB hex → relative luminance, so a literal role can be measured
 *  the way the oklch stops used to be. */
function luminanceOf(hex: string): number {
	const parsed = /^#([0-9a-f]{6})$/i.exec(hex.trim());
	if (!parsed) throw new Error(`not a six-digit hex colour: "${hex}".`);
	const channel = (offset: number) => {
		const value = Number.parseInt(parsed[1].slice(offset, offset + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two declared hex roles. */
function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** Read one role from both themes, failing loudly if either is missing. */
function pairOf(role: string): [light: string, dark: string] {
	const light = declaredIn(root, role);
	const darkValue = declaredIn(dark, role);
	expect(light, `:root ${role} is declared`).toBeDefined();
	expect(darkValue, `.dark ${role} is declared`).toBeDefined();
	return [light ?? '', darkValue ?? ''];
}

describe('the eleven-step ramp', () => {
	it('is achromatic and ordered, so a stop number is one tone in either theme', () => {
		const lightness = rampStops.map((stop) => {
			const value = declaredIn(root, stop) ?? '';
			// Chroma is the second component: a hue anywhere in the ramp would tint
			// every surface in the app at once.
			expect(value, stop).toMatch(/^oklch\([\d.]+ 0 0\)$/);
			return lightnessOf(value);
		});

		for (let index = 1; index < lightness.length; index += 1) {
			expect(lightness[index], `z${index} is lighter than z${index - 1}`).toBeGreaterThan(
				lightness[index - 1]
			);
		}
	});

	it('is declared once, so both themes read the same ramp', () => {
		for (const stop of rampStops) {
			expect(declaredIn(dark, stop), `${stop} must not be re-declared in .dark`).toBeUndefined();
		}
	});
});

describe('the semantic roles', () => {
	// CHANGED (ticket 02): replaces "alias a stop rather than carrying a literal,
	// in both themes". The cool Vellum reference re-points these sixteen roles at
	// approved hex literals instead of ramp stops, so the alias relationship is
	// retired. What must hold now: every role is declared in both themes and the
	// theme still moves it — otherwise dark is the light theme with a class on it.
	it('are declared in both themes, each with a value its dark theme differs from', () => {
		for (const role of vellumRoles) {
			const [light, darkValue] = pairOf(role);
			// The hairline is drawn in neither theme: the rule is transparent in both.
			if (role === 'rule') continue;
			expect(light, `:root ${role} differs from .dark ${role}`).not.toBe(darkValue);
		}
	});

	it('moves the roles and not the ladder when the theme flips', () => {
		// The page is the plainest witness: if the roles did not move, the dark
		// theme would be the light one with a class on it.
		expect(declaredIn(root, 'page')).not.toBe(declaredIn(dark, 'page'));
		expect(declaredIn(root, 'panel')).not.toBe(declaredIn(dark, 'panel'));
	});
});

describe('the action role', () => {
	// CHANGED (ticket 02): both former tests ("is the ramp's own extreme, not a
	// hue" and "carries no chroma of its own") pinned stop aliases and a
	// chroma-free spelling the cool reference no longer uses. What those tests
	// protected was the primary control's and body text's legibility, so the
	// replacements measure the contrast directly instead of pinning the syntax.
	it('--action clears 4.5:1 against --on-action in both themes', () => {
		for (const theme of ['light', 'dark'] as const) {
			const block = theme === 'light' ? root : dark;
			const ratio = contrastRatio(
				declaredIn(block, 'action') ?? '',
				declaredIn(block, 'on-action') ?? ''
			);
			expect(ratio, `${theme} action on on-action`).toBeGreaterThanOrEqual(4.5);
		}
	});

	it('--ink clears 4.5:1 on --page in both themes', () => {
		for (const theme of ['light', 'dark'] as const) {
			const block = theme === 'light' ? root : dark;
			const ratio = contrastRatio(declaredIn(block, 'ink') ?? '', declaredIn(block, 'page') ?? '');
			expect(ratio, `${theme} ink on page`).toBeGreaterThanOrEqual(4.5);
		}
	});

	// Decision 1 (brief): --rule-strong is a control boundary held to 3:1 by
	// WCAG 1.4.11, and the reference's #c9d3e0 / #39424f measure 1.51:1 and
	// 1.68:1 — failures. The role takes the meeting hexes; this test is what
	// makes the deviation a rule rather than a taste call.
	it('--rule-strong holds 3:1 against --panel in both themes', () => {
		for (const theme of ['light', 'dark'] as const) {
			const block = theme === 'light' ? root : dark;
			const ratio = contrastRatio(
				declaredIn(block, 'rule-strong') ?? '',
				declaredIn(block, 'panel') ?? ''
			);
			expect(ratio, `${theme} rule-strong on panel`).toBeGreaterThanOrEqual(3);
		}
	});
});

describe('the material roles', () => {
	it('are defined in both themes, so either theme can glass over or shadow a surface', () => {
		for (const role of materialRoles) {
			pairOf(role);
		}
	});
});

describe('the glass utility', () => {
	it('paints a solid background first, then blur, then @supports glass, then the opaque fallback', () => {
		const glassStart = css.indexOf("[data-material='glass']");
		// From glassStart: the rule's own comment also mentions "@supports".
		const supportsStart = css.indexOf('@supports', glassStart);
		const fallbackStart = css.indexOf('prefers-reduced-transparency');
		const sheetStart = css.indexOf("[data-material='reading-sheet']");
		expect(glassStart, 'the glass utility exists').toBeGreaterThan(-1);
		expect(supportsStart, 'the glass @supports exists').toBeGreaterThan(-1);
		expect(fallbackStart, 'the reduced-transparency fallback exists').toBeGreaterThan(-1);
		expect(sheetStart, 'the reading-sheet utility exists').toBeGreaterThan(-1);

		// A browser without backdrop-filter must still get an opaque surface, so
		// the solid paints before @supports ever runs, and the fallback lands last.
		expect(glassStart).toBeLessThan(supportsStart);
		expect(supportsStart).toBeLessThan(fallbackStart);
		expect(fallbackStart).toBeLessThan(sheetStart);

		const base = css.slice(glassStart, supportsStart);
		expect(base, 'solid background first').toMatch(
			/background-color:\s*var\(--surface-glass-solid\)/
		);
		expect(base, 'both backdrop-filter properties').toMatch(
			/^\s*-webkit-backdrop-filter:\s*blur\(var\(--surface-blur\)\)/m
		);
		expect(base, 'both backdrop-filter properties').toMatch(
			/^\s*backdrop-filter:\s*blur\(var\(--surface-blur\)\)/m
		);

		const supports = css.slice(supportsStart, fallbackStart);
		expect(supports, '@supports swaps in the translucent glass').toMatch(
			/background-color:\s*var\(--surface-glass\)/
		);

		const fallback = css.slice(fallbackStart, sheetStart);
		expect(fallback, 'reduced transparency gets the solid back').toMatch(
			/background-color:\s*var\(--surface-glass-solid\)/
		);
		expect(fallback, 'forced colors also gets the solid back').toMatch(/forced-colors:\s*active/);
		expect(fallback, 'blur is switched off').toMatch(/^\s*-webkit-backdrop-filter:\s*none/m);
		expect(fallback, 'blur is switched off').toMatch(/^\s*backdrop-filter:\s*none/m);
	});
});

describe('the rail card', () => {
	it('composes the 1px ring into its shadow, so neither layer can be lost', () => {
		// The rail rule is unlayered on purpose, to outrank the primitive's
		// `rounded-item` and `shadow-sm`. That also means it owns `box-shadow`
		// outright: in Tailwind 4 `ring-1` writes that property too, so a bare
		// `box-shadow: var(--rail-shadow)` silently drops the ring.
		const rule = /[^}]*\[data-slot='sidebar-inner'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
		expect(rule, 'the rail card rule exists').not.toBe('');

		expect(rule, 'the rail radius').toMatch(/border-radius:\s*0\.875rem/);
		expect(rule, 'the ring layer survives').toMatch(/0 0 0 1px var\(--sidebar-border\)/);
		expect(rule, 'the rail shadow layer survives').toMatch(/var\(--rail-shadow\)/);
	});
});

describe('the glass rails', () => {
	it('keeps the hairline and elevation together beside the Workers table and canvas', () => {
		const rule = blockAt("[data-material='glass'][data-rail]");
		expect(rule, 'the ring layer survives').toMatch(/0 0 0 1px var\(--rule\)/);
		expect(rule, 'the elevation layer survives').toMatch(/var\(--rail-shadow\)/);
	});

	it('keeps a system-colour edge when forced colors removes box shadows', () => {
		const forced = blockAt('@media (forced-colors: active)');
		expect(forced).toContain("[data-material='glass'][data-rail]");
		expect(forced).toContain("[data-slot='sidebar-inner']");
		expect(forced).toMatch(/outline:\s*1px solid CanvasText/);
	});
});

describe('the Assessment palette', () => {
	it('lifts all six for the dark theme, so a standing means one thing in either', () => {
		for (const name of assessmentNames) {
			const lifted = declaredIn(dark, name);
			expect(lifted, `${name} has a dark step`).toMatch(/^#[0-9a-f]{6}$/);
			// Apple's systemGray is one value in both appearances, so Unassessed holds.
			if (name === 'assess-unassessed') continue;
			expect(lifted, `${name} is lifted, not swapped for another meaning`).not.toBe(
				declaredIn(root, name)
			);
		}
	});
});

describe('the toolbar key', () => {
	// CHANGED (ticket 02, Decision 2): the old test read lightness through
	// oklch ramp stops via stopOf(), which throws for literal roles, so it could
	// not run against the cool tokens. The intent is kept exactly: the scoped
	// rule still exists, and ink-2 still clears 4.5:1 on the toolbar fill in
	// both themes — now measured from the declared hexes.
	it('steps up to ink-2 on the toolbar fill, clearing 4.5:1 in both themes', () => {
		expect(css).toMatch(/\.bg-toolbar \.key\s*\{\s*color:\s*var\(--ink-2\);\s*\}/);
		for (const theme of ['light', 'dark'] as const) {
			const block = theme === 'light' ? root : dark;
			const ratio = contrastRatio(
				declaredIn(block, 'ink-2') ?? '',
				declaredIn(block, 'toolbar') ?? ''
			);
			expect(ratio, `${theme} ink-2 on toolbar`).toBeGreaterThanOrEqual(4.5);
		}
	});
});

describe('the field-label role', () => {
	it('reads as language at the 12px floor, never as a tracked mono eyebrow', () => {
		const block = blockAt('.field-label');
		expect(block).toMatch(/font-family:\s*var\(--font-sans\)/);
		expect(block).not.toMatch(/text-transform:\s*uppercase/);
		const size = /font-size:\s*max\([^,]+,\s*([\d.]+)px\)/.exec(block)?.[1];
		expect(Number(size ?? 0)).toBeGreaterThanOrEqual(12);
	});
});

describe('the Text size override', () => {
	it('multiplies with Density on the root font size instead of replacing it', () => {
		expect(css, 'Density exposes its scale').toMatch(/--density-scale:\s*0\.9375/);
		expect(css, 'Text size exposes its scale').toMatch(/--text-scale:\s*1\.25/);
		expect(css, 'the root font size composes both scales').toMatch(
			/font-size:\s*calc\(100% \* var\(--density-scale\) \* var\(--text-scale\)\)/
		);

		for (const density of ['compact', 'standard', 'comfortable']) {
			expect(blockAt(`html[data-density='${density}']`), density).not.toMatch(/font-size:/);
		}
	});
});

describe('the Increase contrast override', () => {
	const contrastBlocks = {
		light: blockAt("html[data-contrast='on']"),
		dark: blockAt(".dark[data-contrast='on']")
	};
	const surfaces = { light: '#ffffff', dark: '#181818' };

	it('declares the rule and ink roles in both themes', () => {
		for (const theme of ['light', 'dark'] as const) {
			for (const role of ['rule', 'rule-strong', 'ink-2', 'ink-3', 'focus']) {
				expect(declaredIn(contrastBlocks[theme], role), `${theme} ${role}`).toMatch(
					/^#[0-9a-f]{6}$/
				);
			}
		}
	});

	it('strengthens the measured roles past the default theme', () => {
		const measured = ['rule', 'rule-strong', 'ink-2', 'ink-3'] as const;
		for (const theme of ['light', 'dark'] as const) {
			const base = theme === 'light' ? root : dark;
			for (const role of measured) {
				const before = contrastRatio(declaredIn(base, role) ?? '', surfaces[theme]);
				const after = contrastRatio(declaredIn(contrastBlocks[theme], role) ?? '', surfaces[theme]);
				expect(after, `${theme} ${role} is stronger`).toBeGreaterThan(before);
			}
		}
	});

	it('holds the text roles at 7:1 and the control boundary at 4.5:1', () => {
		for (const theme of ['light', 'dark'] as const) {
			const block = contrastBlocks[theme];
			for (const role of ['ink-2', 'ink-3'] as const) {
				expect(
					contrastRatio(declaredIn(block, role) ?? '', surfaces[theme]),
					`${theme} ${role}`
				).toBeGreaterThanOrEqual(7);
			}
			expect(
				contrastRatio(declaredIn(block, 'rule-strong') ?? '', surfaces[theme]),
				`${theme} rule-strong`
			).toBeGreaterThanOrEqual(4.5);
		}
	});
});

describe('the color-blind Assessment palette', () => {
	const paletteLight = blockAt("html[data-assessment-palette='colorblind']");
	const paletteDark = blockAt(".dark[data-assessment-palette='colorblind']");

	it('re-declares all three chains together in both themes', () => {
		for (const [theme, block] of [
			['light', paletteLight],
			['dark', paletteDark]
		] as const) {
			for (const name of [
				'unassessed',
				'leader',
				'activist',
				'supporter',
				'disengaged',
				'hostile'
			]) {
				expect(block, `${theme} --assess-${name}`).toMatch(
					new RegExp(`--assess-${name}:\\s*#[0-9a-f]{6};`)
				);
				expect(block, `${theme} --assessment-${name}`).toContain(
					`--assessment-${name}: var(--assess-${name});`
				);
				expect(block, `${theme} --color-assessment-${name}`).toContain(
					`--color-assessment-${name}: var(--assessment-${name});`
				);
			}
		}
	});

	it('lands after the theme block, so all three chains resolve to the swapped values', () => {
		expect(css.indexOf('@theme inline')).toBeGreaterThan(-1);
		expect(css.indexOf('@theme inline')).toBeLessThan(
			css.indexOf("html[data-assessment-palette='colorblind']")
		);
	});
});
