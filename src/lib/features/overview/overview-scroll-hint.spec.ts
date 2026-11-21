import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCROLL_HINT_SLACK_PX, scrollHint } from './overview-scroll-hint.ts';

type FakeScroller = {
	scrollWidth: number;
	clientWidth: number;
	scrollHeight: number;
	clientHeight: number;
	scrollLeft: number;
	scrollTop: number;
	dataset: Record<string, string>;
	firstElementChild: null;
	addEventListener: () => void;
	removeEventListener: () => void;
};

function scroller(overrides: Partial<FakeScroller>): FakeScroller {
	return {
		scrollWidth: 300,
		clientWidth: 300,
		scrollHeight: 200,
		clientHeight: 200,
		scrollLeft: 0,
		scrollTop: 0,
		dataset: {},
		firstElementChild: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		...overrides
	};
}

function hint(node: FakeScroller) {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		}
	);
	return scrollHint(node as unknown as HTMLElement);
}

afterEach(() => vi.unstubAllGlobals());

describe('scrollHint', () => {
	it('fades the bottom edge of a scroller with real rows beyond it', () => {
		const node = scroller({ scrollHeight: 200 + SCROLL_HINT_SLACK_PX + 1 });
		hint(node);
		expect(node.dataset.bottom).toBe('true');
		expect(node.dataset.top).toBe('false');
	});

	it('treats a few pixels of edge spacing as fitting, so no row is faded', () => {
		const node = scroller({ scrollHeight: 200 + SCROLL_HINT_SLACK_PX });
		hint(node);
		expect(node.dataset.bottom).toBe('false');
		expect(node.dataset.top).toBe('false');
	});

	it('fades the top once a long scroller has been scrolled', () => {
		const node = scroller({ scrollHeight: 400, scrollTop: 50 });
		hint(node);
		expect(node.dataset.top).toBe('true');
		expect(node.dataset.bottom).toBe('true');
	});

	it('drops the bottom fade at the end of a long scroller', () => {
		const node = scroller({ scrollHeight: 400, scrollTop: 200 });
		hint(node);
		expect(node.dataset.bottom).toBe('false');
	});

	it('applies the same slack across the horizontal edges', () => {
		const slack = scroller({ scrollWidth: 300 + SCROLL_HINT_SLACK_PX });
		hint(slack);
		expect(slack.dataset.right).toBe('false');
		const wide = scroller({ scrollWidth: 400 });
		hint(wide);
		expect(wide.dataset.right).toBe('true');
	});
});
