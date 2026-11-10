import { describe, expect, it } from 'vitest';
import type { Agitation } from '#lib/domain-vocabulary.ts';
import { agitationCandidates } from './agitation-candidates.ts';

const pay: Agitation = { id: 'a1', text: 'Pay' };
const hours: Agitation = { id: 'a2', text: 'Hours' };
const sundays: Agitation = { id: 'a3', text: 'Closed on Sundays' };
const worksite = [pay, hours, sundays];

describe('agitationCandidates', () => {
	it('offers every worksite Agitation the Worker does not hold, with no query', () => {
		const { matches, exact } = agitationCandidates({ agitations: ['a1'] }, worksite, '');

		expect(matches.map((agitation) => agitation.text)).toEqual(['Hours', 'Closed on Sundays']);
		expect(exact).toBeUndefined();
	});

	it('filters the unheld Agitations by case-insensitive substring', () => {
		const { matches } = agitationCandidates({ agitations: [] }, worksite, '  SUN ');

		expect(matches.map((agitation) => agitation.text)).toEqual(['Closed on Sundays']);
	});

	it('leaves out Agitations the Worker already holds, even when they match', () => {
		const { matches, exact } = agitationCandidates({ agitations: ['a1'] }, worksite, 'pay');

		expect(matches).toEqual([]);
		expect(exact).toBe(pay);
	});

	it('reports an exact match case-insensitively and ignores surrounding spaces', () => {
		const { matches, exact } = agitationCandidates({ agitations: [] }, worksite, '  hOURS ');

		expect(exact).toBe(hours);
		expect(matches).toEqual([hours]);
	});

	it('reports no exact match for a partial name', () => {
		const { exact } = agitationCandidates({ agitations: [] }, worksite, 'Hour');

		expect(exact).toBeUndefined();
	});

	it('offers nothing for a worksite with no Agitations', () => {
		expect(agitationCandidates({ agitations: [] }, [], '')).toEqual({
			matches: [],
			exact: undefined
		});
	});
});
