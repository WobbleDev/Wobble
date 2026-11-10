export type Choice = { value: string; label: string };

export function labelOf(choices: Choice[], value: string): string {
	return choices.find((choice) => choice.value === value)?.label ?? '';
}
