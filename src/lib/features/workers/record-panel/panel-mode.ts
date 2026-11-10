/** What the record panel shows: checked workers win over the open Worker. */
export type PanelMode = 'summary' | 'worker' | 'empty';

export function panelMode(checkedCount: number, hasOpenWorker: boolean): PanelMode {
	if (checkedCount > 0) return 'summary';
	return hasOpenWorker ? 'worker' : 'empty';
}
