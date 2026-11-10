/** What a Settings row offers the control it renders: which description IDs exist. */
export const settingsRowContextKey = Symbol('settings-row');

export type SettingsRowContext = {
	/**
	 * Space-separated `aria-describedby` targets the row actually renders: its description
	 * and its "Not available yet" note, each only when present, or undefined when neither.
	 */
	describedby?: string;
};
