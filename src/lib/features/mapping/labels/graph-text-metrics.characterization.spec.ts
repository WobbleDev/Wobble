/**
 * Pins how the map sizes its text today, ahead of splitting map-canvas: the character-count
 * estimate, the snapshot revision that tells the layout when to rerun, and the measuring and
 * font-request code read through a minimal literal DOM (no browser). Synthetic strings only.
 */
// @module-tag mapping
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	estimateTextSnapshot,
	headingFontPx,
	measureTextSnapshot,
	nameFontPx,
	textFontRequests,
	type HeadingText,
	type NameText
} from './graph-text-metrics.ts';

afterEach(() => vi.unstubAllGlobals());

const names: NameText[] = [
	{ id: 'w1', text: 'Ada' },
	{ id: 'w2', text: 'Grace Hopper' }
];
const headings: HeadingText[] = [{ key: 'front', label: 'Front', count: 12, child: false }];

describe('estimateTextSnapshot', () => {
	it('sizes a name from its character count, with room for the stroke', () => {
		const snapshot = estimateTextSnapshot(names, headings);
		expect(snapshot.source).toBe('estimate');
		// 3 * 12 * 0.56 + 3 * 12 * 0.12 + 3
		expect(snapshot.names.get('w1')?.width).toBeCloseTo(27.48, 5);
		expect(snapshot.names.get('w1')?.height).toBe(14);
		expect(snapshot.names.get('w2')?.width).toBeCloseTo(12 * 12 * 0.68 + 3, 5);
	});

	it('sizes a heading from "label  · count", counting characters not bytes', () => {
		const heading = estimateTextSnapshot([], headings).headings.get('front');
		expect(heading?.width).toBeCloseTo(11 * 11 * 0.72, 5);
		expect(heading?.height).toBe(15);
		const accented = estimateTextSnapshot([], [{ key: 'k', label: 'Zoë', count: 3, child: true }]);
		expect(accented.headings.get('k')?.width).toBeCloseTo(8 * 11 * 0.72, 5);
	});

	it('keeps the order and ids it was given, and is empty for no text', () => {
		const snapshot = estimateTextSnapshot(names, headings);
		expect([...snapshot.names.keys()]).toEqual(['w1', 'w2']);
		const empty = estimateTextSnapshot([], []);
		expect(empty.names.size).toBe(0);
		expect(empty.headings.size).toBe(0);
	});

	it('changes its revision exactly when a displayed string changes', () => {
		const base = estimateTextSnapshot(names, headings).revision;
		expect(estimateTextSnapshot(names, headings).revision).toBe(base);
		expect(base.startsWith('estimate:')).toBe(true);
		const renamed = [{ id: 'w1', text: 'Adaa' }, names[1]!];
		expect(estimateTextSnapshot(renamed, headings).revision).not.toBe(base);
		expect(estimateTextSnapshot(names, [{ ...headings[0]!, label: 'Back' }]).revision).not.toBe(
			base
		);
		// The heading count and the child flag change the size or nothing the layout reads.
		expect(estimateTextSnapshot(names, [{ ...headings[0]!, child: true }]).revision).toBe(base);
	});

	it('exposes the screen font sizes the map draws at', () => {
		expect([nameFontPx, headingFontPx]).toEqual([12, 11]);
	});
});

/** A tiny element tree: enough DOM for the measurer, with sizes the spec controls. */
function fakeDocument(
	options: { box?: (text: string) => { width: number; height: number; y: number } } = {}
) {
	const box = options.box ?? ((text: string) => ({ width: text.length * 7, height: 13, y: -10 }));
	const log: string[] = [];
	function element(tag: string) {
		const el: Record<string, unknown> = {
			tag,
			children: [] as unknown[],
			attributes: {} as Record<string, string>,
			style: {} as Record<string, string>,
			textContent: '',
			setAttribute(name: string, value: string) {
				(el.attributes as Record<string, string>)[name] = value;
			},
			appendChild(child: unknown) {
				(el.children as unknown[]).push(child);
				return child;
			},
			querySelector(selector: string) {
				const wanted = selector.replace('.', '');
				const walk = (node: Record<string, unknown>): unknown => {
					for (const child of node.children as Record<string, unknown>[]) {
						if ((child.attributes as Record<string, string>)?.class === wanted) return child;
						const found = walk(child);
						if (found) return found;
					}
					return null;
				};
				return walk(el);
			},
			getBBox() {
				const own = el.textContent as string;
				const nested = (el.children as Record<string, unknown>[])
					.map((c) => (c.textContent as string) ?? '')
					.join('');
				return box(own + nested);
			},
			remove() {
				log.push('removed');
			}
		};
		return el;
	}
	const doc = {
		createElementNS: (_ns: string, tag: string) => element(tag),
		createTextNode: (text: string) => ({ textContent: text, children: [], attributes: {} })
	};
	return { doc, log, host: element('div') as unknown as Element };
}

describe('measureTextSnapshot', () => {
	function setup() {
		const dom = fakeDocument();
		vi.stubGlobal('document', dom.doc);
		vi.stubGlobal('getComputedStyle', (el: { attributes: { class?: string } }) => ({
			fontFamily: el.attributes.class === 'label' ? 'Mono' : 'Sans',
			fontWeight: el.attributes.class === 'label' ? '400' : '500',
			letterSpacing: '0px',
			fontSize: '12px'
		}));
		return dom;
	}

	it('reads each name and heading box in CSS pixels and says it was measured', () => {
		const { host } = setup();
		const snapshot = measureTextSnapshot(host, names, headings);
		expect(snapshot.source).toBe('measured');
		expect(snapshot.names.get('w1')).toEqual({ width: 21, height: 13 });
		expect(snapshot.names.get('w2')).toEqual({ width: 84, height: 13 });
		// "Front" plus the "· 12" count span, with the baseline taken from the box's top.
		expect(snapshot.headings.get('front')).toEqual({ width: 63, height: 13, baseline: 10 });
	});

	it('removes its measuring element even though it is created inside the host', () => {
		const { host, log } = setup();
		measureTextSnapshot(host, names, headings);
		expect(log).toEqual(['removed']);
	});

	it('gives measured and estimated snapshots different revisions, and a font change a new one', () => {
		const { host } = setup();
		const measured = measureTextSnapshot(host, names, headings);
		expect(measured.revision.startsWith('measured:')).toBe(true);
		expect(measured.revision).not.toBe(estimateTextSnapshot(names, headings).revision);
		expect(measureTextSnapshot(host, names, headings).revision).toBe(measured.revision);
		vi.stubGlobal('getComputedStyle', () => ({
			fontFamily: 'Serif',
			fontWeight: '700',
			letterSpacing: '1px',
			fontSize: '12px'
		}));
		expect(measureTextSnapshot(host, names, headings).revision).not.toBe(measured.revision);
	});
});

describe('textFontRequests', () => {
	it('asks for the first family of each face with the glyphs the map draws', () => {
		const dom = fakeDocument();
		vi.stubGlobal('document', dom.doc);
		vi.stubGlobal('getComputedStyle', (el: { attributes: { class?: string } }) => ({
			fontFamily:
				el.attributes.class === 'label' ? '"Roboto Mono", monospace' : '"Public Sans", sans-serif',
			fontWeight: el.attributes.class === 'label' ? '400' : '500',
			fontSize: '12px'
		}));
		expect(textFontRequests(dom.host, names, headings)).toEqual([
			{ font: '500 12px "Public Sans"', text: 'AdaGrace Hopper' },
			{ font: '400 12px "Roboto Mono"', text: 'Front' }
		]);
		expect(dom.log).toEqual(['removed']);
	});
});
