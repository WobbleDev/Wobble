import { ApiError, readErrorCode } from './api-error.ts';

function getResponseMessage(value: unknown): string | null {
	return typeof value === 'object' &&
		value !== null &&
		'message' in value &&
		typeof value.message === 'string'
		? value.message
		: null;
}

export async function parseApiResponse(
	response: Response,
	fallbackMessage: (status: number) => string
): Promise<unknown> {
	let result: unknown;
	try {
		result = await response.json();
	} catch (error) {
		throw new Error(
			response.ok ? 'Server returned an invalid response.' : fallbackMessage(response.status),
			{ cause: error }
		);
	}

	if (!response.ok) {
		throw new ApiError(
			response.status,
			getResponseMessage(result) ?? fallbackMessage(response.status),
			readErrorCode(result),
			result
		);
	}

	return result;
}
