import { describe, expect, it } from 'vitest';
import { flightFrames, travelOf } from './committee-flight.ts';

const column = { left: 100, top: 40, width: 336, height: 600 };
const card = { left: 900, top: 120, width: 300, height: 140 };

describe('travelOf', () => {
	it('puts the column on the card at rest, with the dashboard unslid', () => {
		expect(travelOf({ card, column, slide: 0 })).toEqual({
			dx: 800,
			dy: 80,
			right: 36,
			bottom: 460
		});
	});

	it('takes the dashboard slide off the card when leaving', () => {
		// Focused, the dashboard stands 700px left of rest, so the card reads 700px left too.
		const slid = { ...card, left: card.left - 700 };
		expect(travelOf({ card: slid, column, slide: -700 }).dx).toBe(800);
	});

	it('never clips by a negative amount when the card is larger than the column', () => {
		const wide = { ...card, width: 500, height: 900 };
		const travel = travelOf({ card: wide, column, slide: 0 });
		expect(travel.right).toBe(0);
		expect(travel.bottom).toBe(0);
	});
});

describe('flightFrames', () => {
	const travel = travelOf({ card, column, slide: 0 });

	it('enters from the card to its own place, appearing at once', () => {
		const frames = flightFrames(travel, true);
		expect(frames[0]).toMatchObject({ opacity: 0, transform: 'translate(800px, 80px)' });
		expect(frames[1]).toMatchObject({ opacity: 1, transform: 'translate(800px, 80px)' });
		expect(frames.at(-1)).toMatchObject({ opacity: 1, transform: 'none' });
	});

	it('leaves the same way backwards, vanishing on the card', () => {
		const frames = flightFrames(travel, false);
		expect(frames[0]).toMatchObject({ opacity: 1, transform: 'none' });
		expect(frames.at(-1)).toMatchObject({ opacity: 0, transform: 'translate(800px, 80px)' });
	});

	it('clips the column to the card and opens it', () => {
		const frames = flightFrames(travel, true);
		expect(frames[0].clipPath).toBe('inset(0px 36px 460px 0px round 0.625rem)');
		expect(frames.at(-1)?.clipPath).toBe('inset(0px 0px 0px 0px round 0.625rem)');
	});
});
