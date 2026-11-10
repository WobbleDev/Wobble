/** The complete, count-aware copy one bulk run reports with. */
export type BulkCopy = {
	/** The field labels the Assessment and Languages batches name in their reports. */
	assessmentField: string;
	languagesField: string;
	reloadFailed: string;
	count: (count: number) => string;
	saved: (field: string, count: number) => string;
	savedPartial: (field: string, applied: number, requested: number) => string;
	assessmentFailed: (count: number) => string;
	languagesFailed: (count: number) => string;
	setFailed: (field: string, count: number) => string;
	changeFailed: (field: string, count: number) => string;
	deleteFailed: (count: number) => string;
	deleted: (count: number) => string;
	deletedPartial: (applied: number, total: number) => string;
};
