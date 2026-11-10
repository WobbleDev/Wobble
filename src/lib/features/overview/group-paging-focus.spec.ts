/**
 * Focus after a page turn, specced through the factory with literal buttons: a turn that
 * disables the button it was made with hands focus to the pager's other button.
 */
import { describe, expect, it } from 'vitest';
import { createGroupPaging } from './group-paging.svelte.ts';

function pager(disabled: { previous: boolean; next: boolean }) {
	const focused: string[] = [];
	const button = (name: 'previous' | 'next') => ({
		isConnected: true,
		matches: (selector: string) => selector === ':disabled' && disabled[name],
		focus: () => focused.push(name),
		closest: () => ({
			querySelector: () => ({
				focus: () => focused.push(name === 'next' ? 'previous' : 'next')
			})
		})
	});
	return {
		focused,
		previous: button('previous') as unknown as Element,
		next: button('next') as unknown as Element
	};
}

describe('focus after a page turn', () => {
	it('moves to Previous when the turn forward disables Next', async () => {
		const { focused, next } = pager({ previous: false, next: true });
		createGroupPaging({ pageCount: () => 3, groupingKey: () => 'k' }).goTo(2, next);
		await Promise.resolve();
		await Promise.resolve();
		expect(focused).toEqual(['previous']);
	});

	it('moves to Next when the turn back disables Previous', async () => {
		const { focused, previous } = pager({ previous: true, next: false });
		createGroupPaging({ pageCount: () => 3, groupingKey: () => 'k' }).goTo(0, previous);
		await Promise.resolve();
		await Promise.resolve();
		expect(focused).toEqual(['next']);
	});

	it('leaves focus where it is while the button stays enabled', async () => {
		const { focused, next } = pager({ previous: false, next: false });
		createGroupPaging({ pageCount: () => 3, groupingKey: () => 'k' }).goTo(1, next);
		await Promise.resolve();
		await Promise.resolve();
		expect(focused).toEqual([]);
	});
});
