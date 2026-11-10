import { describe, expect, it } from 'vitest';
import { hasCommandModifier, viewForKey } from './shortcuts.svelte.ts';

const keys = { altKey: false, shiftKey: false, metaKey: false, ctrlKey: false };

describe('viewForKey', () => {
	it('maps 1, 2 and 3 to the views', () => {
		expect(['1', '2', '3'].map(viewForKey)).toEqual(['/overview', '/workers', '/mapping']);
	});
	it('ignores other keys, including inherited property names', () => {
		expect(viewForKey('4')).toBeUndefined();
		expect(viewForKey('constructor')).toBeUndefined();
	});
});

describe('hasCommandModifier', () => {
	it('wants Cmd alone on a Mac and Ctrl alone elsewhere', () => {
		expect(hasCommandModifier({ ...keys, metaKey: true }, true)).toBe(true);
		expect(hasCommandModifier({ ...keys, ctrlKey: true }, true)).toBe(false);
		expect(hasCommandModifier({ ...keys, ctrlKey: true }, false)).toBe(true);
		expect(hasCommandModifier({ ...keys, metaKey: true }, false)).toBe(false);
		expect(hasCommandModifier({ ...keys, metaKey: true, ctrlKey: true }, true)).toBe(false);
	});
	it('rejects Alt and Shift', () => {
		expect(hasCommandModifier({ ...keys, metaKey: true, altKey: true }, true)).toBe(false);
		expect(hasCommandModifier({ ...keys, ctrlKey: true, shiftKey: true }, false)).toBe(false);
	});
});
