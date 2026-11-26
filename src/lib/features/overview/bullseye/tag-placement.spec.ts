import { describe, expect, it } from 'vitest';
import { placeNameTags, type MeasuredNameTag } from './tag-placement.ts';

const GAP = 6;

function tag(id: string, cx: number, cy: number, width = 40, height = 16): MeasuredNameTag {
	return { id, cx, cy, width, height };
}

describe('placeNameTags', () => {
	it('keeps every tag above its dot when their boxes do not meet', () => {
		const placements = placeNameTags(
			[tag('a', 40, 40), tag('b', 140, 40), tag('c', 40, 140)],
			null,
			GAP
		);

		expect(placements.map((placement) => placement.side)).toEqual(['above', 'above', 'above']);
	});

	it('flips a tag below its dot when above would cover the one already placed', () => {
		const placements = placeNameTags([tag('a', 128, 128), tag('b', 128, 128)], null, GAP);

		expect(placements[0]).toEqual({ id: 'a', side: 'above' });
		expect(placements[1]).toEqual({ id: 'b', side: 'below' });
	});

	it('places the selected Leader above its dot before any tie tag claims the space', () => {
		// The selected tag comes last in the list, and a tie tag has already claimed
		// it: the Leader still keeps the preferred place above their dot, and every
		// tie moves out of the way instead.
		const placements = placeNameTags(
			[tag('tie-a', 100, 100), tag('tie-b', 100, 100), tag('leader', 100, 100)],
			'leader',
			GAP
		);

		expect(placements.find((placement) => placement.id === 'leader')).toEqual({
			id: 'leader',
			side: 'above'
		});
		expect(
			placements
				.filter((placement) => placement.id !== 'leader')
				.every((placement) => placement.side !== 'above')
		).toBe(true);
	});

	it('offsets a tag beside its dot when both above and below are taken', () => {
		const placements = placeNameTags(
			[tag('a', 128, 128), tag('b', 128, 128), tag('c', 128, 128)],
			null,
			GAP
		);

		expect(placements[2].side).toBe('beside-start');
	});
});
