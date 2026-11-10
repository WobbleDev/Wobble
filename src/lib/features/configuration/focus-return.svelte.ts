/**
 * Returns focus to what held it before a dialog opened. A dialog opened from code, not
 * from a trigger, has nothing for the primitive to give focus back to, so focus would
 * fall to the page body. Call during component setup; pass the result to the dialog
 * content's `onCloseAutoFocus`.
 */
export function createFocusReturn(isOpen: () => boolean): (event: Event) => void {
	let opener: HTMLElement | null = null;

	// Before the DOM update, so the dialog has not yet moved focus inside itself.
	$effect.pre(() => {
		if (!isOpen() || opener) return;
		const active = document.activeElement;
		if (active instanceof HTMLElement && active !== document.body) opener = active;
	});

	return (event) => {
		event.preventDefault();
		const target = opener?.isConnected ? opener : document.getElementById('main-content');
		opener = null;
		target?.focus();
	};
}
