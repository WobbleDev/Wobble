import { describe, expect, it } from 'vitest';
import { createOverviewFocus } from './overview-focus.svelte.ts';

/**
 * The Overview's focus state, specced through the factory the shell mounts:
 * the toggle the edge control drives, the Escape exit the ground yields to a
 * dot's own Escape, and the return to rest on every Overview entrance animation, as the
 * zoom does. The host stands in for the route, as the Mapping drag factory's
 * literal host stands in for the map.
 */
function setup(onOverview = true) {
	let overview = onOverview;
	const focus = createOverviewFocus({ isOverview: () => overview });
	return {
		focus,
		arrive() {
			overview = true;
		},
		leave() {
			overview = false;
		}
	};
}

function key(key: string, defaultPrevented = false): KeyboardEvent {
	return { key, defaultPrevented } as KeyboardEvent;
}

describe('createOverviewFocus', () => {
	it('starts at rest', () => {
		const { focus } = setup();
		expect(focus.focused).toBe(false);
	});

	it('toggles between rest and focus', () => {
		const { focus } = setup();
		focus.toggle();
		expect(focus.focused).toBe(true);
		focus.toggle();
		expect(focus.focused).toBe(false);
	});

	it('blurs back to rest', () => {
		const { focus } = setup();
		focus.toggle();
		focus.blur();
		expect(focus.focused).toBe(false);
		focus.blur();
		expect(focus.focused).toBe(false);
	});

	it('ignores Escape at rest', () => {
		const { focus } = setup();
		focus.handleKeydown(key('Escape'));
		expect(focus.focused).toBe(false);
	});

	it('blurs on Escape while focused', () => {
		const { focus } = setup();
		focus.toggle();
		focus.handleKeydown(key('Escape'));
		expect(focus.focused).toBe(false);
	});

	it('ignores keys other than Escape while focused', () => {
		const { focus } = setup();
		focus.toggle();
		focus.handleKeydown(key('Enter'));
		focus.handleKeydown(key('+'));
		expect(focus.focused).toBe(true);
	});

	it('yields Escape to a dot that already consumed it', () => {
		const { focus } = setup();
		focus.toggle();
		focus.handleKeydown(key('Escape', true));
		expect(focus.focused).toBe(true);
	});

	it('resets to rest on entrance animation at the Overview', () => {
		const { focus, leave, arrive } = setup();
		focus.toggle();
		leave();
		focus.resetOnEntranceAnimation();
		expect(focus.focused).toBe(true);
		arrive();
		focus.resetOnEntranceAnimation();
		expect(focus.focused).toBe(false);
	});
});
