import { describe, expect, it } from 'vitest';
import { assessmentOptions } from '#lib/domain-vocabulary.ts';
import { isSupportAssessment } from './assessment.ts';

describe('isSupportAssessment', () => {
	it('classifies only Leader, Activist, and Supporter as support assessments', () => {
		expect(assessmentOptions.map(isSupportAssessment)).toEqual([
			false,
			true,
			true,
			true,
			false,
			false
		]);
	});
});
