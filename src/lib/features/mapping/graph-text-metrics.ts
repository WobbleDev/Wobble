/**
 * Displayed text, measured. The browser is the only place that knows how wide a
 * name or a heading really draws, so one reusable SVG measurer lives here and
 * hands the Arrangement numbers only: a revisioned snapshot of CSS-pixel sizes.
 * Where measurement is unavailable (fonts not ready, no DOM) the same snapshot
 * is filled from the conservative character-count estimate and says so.
 */
import { estimateLabelWidth } from './graph-label-placement.ts';

export type TextSize = { width: number; height: number; baseline?: number };

export type TextSnapshot = {
	source: 'measured' | 'estimate';
	/** Changes exactly when a displayed string or its effective font metrics change. */
	revision: string;
	/** Worker id to the size of its displayed name, in CSS pixels. */
	names: ReadonlyMap<string, TextSize>;
	/** Region key to the size of its heading, count included, in CSS pixels. */
	headings: ReadonlyMap<string, TextSize>;
};

export type NameText = { id: string; text: string };
export type HeadingText = { key: string; label: string; count: number; child: boolean };

/** The screen sizes the map draws its text at, before any zoom. */
export const nameFontPx = 12;
export const headingFontPx = 11;
/** The estimate leaves room for the proportional face and the stroke that keeps text legible. */
const nameHeightPx = 14;
const headingHeightPx = 15;

function hashOf(parts: readonly string[]): string {
	let hash = 2166136261;
	for (const part of parts) {
		for (let i = 0; i < part.length; i += 1) {
			hash ^= part.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		hash ^= 0x1f;
	}
	return (hash >>> 0).toString(36);
}

function revisionOf(
	source: string,
	fonts: string,
	names: ReadonlyMap<string, TextSize>,
	headings: ReadonlyMap<string, TextSize>,
	texts: readonly string[]
): string {
	const round = (value: number) => String(Math.round(value * 100) / 100);
	return `${source}:${hashOf([
		fonts,
		...texts,
		...[...names].map(
			([id, size]) =>
				`${id}=${round(size.width)}x${round(size.height)}@${round(size.baseline ?? 0)}`
		),
		...[...headings].map(
			([key, size]) =>
				`${key}=${round(size.width)}x${round(size.height)}@${round(size.baseline ?? 0)}`
		)
	])}`;
}

export function estimateTextSnapshot(
	names: readonly NameText[],
	headings: readonly HeadingText[]
): TextSnapshot {
	const nameSizes = new Map<string, TextSize>(
		names.map(({ id, text }) => [
			id,
			{
				width: estimateLabelWidth(text, nameFontPx) + text.length * nameFontPx * 0.12 + 3,
				height: nameHeightPx
			}
		])
	);
	const headingSizes = new Map<string, TextSize>(
		headings.map(({ key, label, count }) => [
			key,
			{
				width: [...`${label}  · ${count}`].length * headingFontPx * 0.72,
				height: headingHeightPx
			}
		])
	);
	return {
		source: 'estimate',
		revision: revisionOf('estimate', '', nameSizes, headingSizes, [
			...names.map((n) => n.text),
			...headings.map((h) => h.label)
		]),
		names: nameSizes,
		headings: headingSizes
	};
}

const svgNamespace = 'http://www.w3.org/2000/svg';

/**
 * Measures the strings as the map renders them, inside `host` so the same
 * inherited font applies. The measuring element is created once and removed
 * before returning. Sizes come from the element's own box, one decimal of a
 * pixel apart from what the renderer will draw.
 */
export function measureTextSnapshot(
	host: Element,
	names: readonly NameText[],
	headings: readonly HeadingText[]
): TextSnapshot {
	const svg = document.createElementNS(svgNamespace, 'svg');
	svg.setAttribute('aria-hidden', 'true');
	svg.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0';
	const make = (className: string, fontPx: number) => {
		const text = document.createElementNS(svgNamespace, 'text');
		text.setAttribute('class', className);
		text.style.fontSize = `${fontPx}px`;
		svg.appendChild(text);
		return text;
	};
	host.appendChild(svg);
	try {
		const nameText = make('font-medium', nameFontPx);
		const nameSizes = new Map<string, TextSize>();
		for (const { id, text } of names) {
			nameText.textContent = text;
			const box = nameText.getBBox();
			nameSizes.set(id, { width: box.width, height: box.height });
		}
		const headingSizes = new Map<string, TextSize>();
		for (const heading of headings) {
			const element = make('label', headingFontPx);
			element.appendChild(document.createTextNode(heading.label));
			const count = document.createElementNS(svgNamespace, 'tspan');
			count.setAttribute('dx', '5');
			count.setAttribute('class', 'num');
			count.textContent = `· ${heading.count}`;
			element.appendChild(count);
			const box = element.getBBox();
			headingSizes.set(heading.key, { width: box.width, height: box.height, baseline: -box.y });
		}
		const nameStyle = getComputedStyle(nameText);
		const headingStyle = getComputedStyle(svg.querySelector('.label') ?? nameText);
		const fonts = [
			nameStyle.fontFamily,
			nameStyle.fontWeight,
			headingStyle.fontFamily,
			headingStyle.fontWeight,
			headingStyle.letterSpacing
		].join('|');
		return {
			source: 'measured',
			revision: revisionOf('measured', fonts, nameSizes, headingSizes, [
				...names.map((n) => n.text),
				...headings.map((h) => h.label)
			]),
			names: nameSizes,
			headings: headingSizes
		};
	} finally {
		svg.remove();
	}
}

/** A web font face the map's text draws in, with the strings that need its glyphs. */
export type FontRequest = { font: string; text: string };

/**
 * The faces the names and headings draw in, read the way {@link measureTextSnapshot}
 * measures them. A web font loads on first use, so `document.fonts.status` reads
 * "loaded" before the map has asked for Public Sans at all; only these requests say
 * whether the glyphs the map draws are there.
 */
export function textFontRequests(
	host: Element,
	names: readonly NameText[],
	headings: readonly HeadingText[]
): FontRequest[] {
	const svg = document.createElementNS(svgNamespace, 'svg');
	svg.setAttribute('aria-hidden', 'true');
	svg.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:0;height:0';
	host.appendChild(svg);
	try {
		const request = (className: string, fontPx: number, text: string): FontRequest => {
			const element = document.createElementNS(svgNamespace, 'text');
			element.setAttribute('class', className);
			element.style.fontSize = `${fontPx}px`;
			svg.appendChild(element);
			const style = getComputedStyle(element);
			// The first family is the web font; the local fallbacks after it need no load.
			const family = style.fontFamily.split(',')[0].trim();
			return { font: `${style.fontWeight} ${style.fontSize} ${family}`, text };
		};
		return [
			request('font-medium', nameFontPx, names.map((n) => n.text).join('')),
			request('label', headingFontPx, headings.map((h) => h.label).join(''))
		];
	} finally {
		svg.remove();
	}
}

type FontSet = Pick<FontFaceSet, 'check' | 'load'>;

/** Whether every requested face already has the glyphs its text needs. */
export function fontsLoadedFor(fonts: FontSet, requests: readonly FontRequest[]): boolean {
	return requests.every(({ font, text }) => fonts.check(font, text));
}

/**
 * Asks for the requested faces and resolves once they are loaded, or after `timeoutMs`:
 * layout waits for the fonts it can have, never indefinitely. The answer says whether
 * they loaded.
 */
export function loadFonts(
	fonts: FontSet,
	requests: readonly FontRequest[],
	timeoutMs: number
): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fontsLoadedFor(fonts, requests)), timeoutMs);
		void Promise.allSettled(requests.map(({ font, text }) => fonts.load(font, text))).then(() => {
			clearTimeout(timer);
			resolve(fontsLoadedFor(fonts, requests));
		});
	});
}
