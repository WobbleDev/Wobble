import { describe, expect, it } from 'vitest';
import { nearestTarget } from './dot-hit.ts';

const targets = [
	{ id: 'a', cx: 10, cy: 10 },
	{ id: 'b', cx: 100, cy: 100 },
	{ id: 'c', cx: 110, cy: 100 }
];

describe('nearestTarget', () => {
	it('answers the nearest target inside the radius', () => {
		expect(nearestTarget(targets, 14, 10, 8)?.id).toBe('a');
		expect(nearestTarget(targets, 104, 100, 8)?.id).toBe('b');
	});

	it('answers null when no target is inside the radius', () => {
		expect(nearestTarget(targets, 50, 50, 8)).toBeNull();
		expect(nearestTarget([], 0, 0, 8)).toBeNull();
	});

	it('includes a target exactly on the radius', () => {
		expect(nearestTarget(targets, 18, 10, 8)?.id).toBe('a');
	});

	it('keeps the first target on a tie, so the order stays deterministic', () => {
		expect(nearestTarget(targets, 105, 100, 8)?.id).toBe('b');
	});

	it('measures in the chart own units, so a phone-sized radius still answers', () => {
		// A 390px fitted chart is about 1.5 user units per screen pixel; the 22px
		// physical half-target is therefore a radius of ~15 units.
		expect(nearestTarget(targets, 10, 22, 15)?.id).toBe('a');
		expect(nearestTarget(targets, 10, 30, 15)).toBeNull();
	});
});
