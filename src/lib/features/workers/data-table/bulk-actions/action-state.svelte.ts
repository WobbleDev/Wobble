/**
 * The Workers table's in-flight action state: which row is saving or deleting, and
 * any failure to show against it.
 */
export function createDataTableActionState() {
	let pending = $state(false);
	let errorMessage = $state('');

	async function run(action: () => Promise<void>, fallbackMessage: string): Promise<boolean> {
		if (pending) return false;

		pending = true;
		errorMessage = '';
		try {
			await action();
			return true;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : fallbackMessage;
			return false;
		} finally {
			pending = false;
		}
	}

	return {
		get pending() {
			return pending;
		},
		get errorMessage() {
			return errorMessage;
		},
		clearError() {
			errorMessage = '';
		},
		setError(message: string) {
			errorMessage = message;
		},
		run
	};
}
