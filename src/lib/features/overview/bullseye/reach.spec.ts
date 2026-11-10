import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/paraglide/runtime.js';
import type { AssessmentOption, Worker } from '#lib/domain-vocabulary.ts';
import { assessmentCounts, committeeReach } from './reach.ts';

afterEach(() => setLocale('en', { reload: false }));

function worker(assessment: AssessmentOption): Worker {
	return {
		id: assessment,
		name: assessment,
		email: '',
		phone: '',
		assessment,
		attributes: {},
		agitations: [],
		languages: [],
		relationships: [],
		notes: []
	};
}

describe('assessmentCounts', () => {
	it('counts every standing, including the empties', () => {
		const counts = assessmentCounts([worker('Leader'), worker('Leader'), worker('Unassessed')]);

		expect(counts).toEqual({
			Unassessed: 1,
			Leader: 2,
			Activist: 0,
			Supporter: 0,
			Disengaged: 0,
			Hostile: 0
		});
	});
});

describe('committeeReach', () => {
	it('names the outermost drawn band holding anyone', () => {
		expect(committeeReach(assessmentCounts([worker('Leader'), worker('Supporter')]))).toBe(
			"The Organizing Committee's sphere of influence reaches the Supporters ring"
		);
	});

	it('says the Committee stands alone when it is the only drawn band', () => {
		expect(committeeReach(assessmentCounts([worker('Leader')]))).toBe(
			'The Organizing Committee stands alone'
		);
	});

	it('names Hostile opposition separately from reach', () => {
		expect(committeeReach(assessmentCounts([worker('Leader'), worker('Hostile')]))).toBe(
			'The Organizing Committee stands alone, opposed by 1 Hostile worker'
		);
	});

	it('distinguishes no influence from opposition only', () => {
		expect(committeeReach(assessmentCounts([]))).toBe(
			'The Organizing Committee has no influence in this worksite yet'
		);
		expect(committeeReach(assessmentCounts([worker('Hostile'), worker('Unassessed')]))).toBe(
			'Influence reaches no one — only opposition sits outside the Organizing Committee'
		);
	});

	it('states the same reach in Spanish, with the Committee and standing labels translated', () => {
		setLocale('es-419', { reload: false });

		expect(committeeReach(assessmentCounts([worker('Hostile'), worker('Unassessed')]))).toBe(
			'La influencia no alcanza a nadie: solo la oposición queda fuera del Comité organizador'
		);
		expect(committeeReach(assessmentCounts([worker('Leader')]))).toBe(
			'El Comité organizador está solo'
		);
		expect(committeeReach(assessmentCounts([worker('Leader'), worker('Hostile')]))).toBe(
			'El Comité organizador está solo; se le opone 1 trabajador Hostil'
		);
		expect(committeeReach(assessmentCounts([worker('Leader'), worker('Supporter')]))).toBe(
			'La esfera de influencia del Comité organizador llega al anillo de Simpatizantes'
		);
	});
});
