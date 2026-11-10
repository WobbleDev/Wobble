import type { RuntimeInfo } from '#lib/client/api-decode.ts';
import type { DataErrorCopy } from '#lib/client/data-api.ts';
import { m } from '#lib/paraglide/messages.js';

/**
 * The running installation's identity as Diagnostics and About read it: the values, the
 * first-read state (so "not loaded yet" never renders as "unavailable"), and the failure
 * when the read did not land. A failed read stays an error, not an empty identity.
 */
export type RuntimeReading = {
	value: RuntimeInfo | null;
	loading: boolean;
	error: DataErrorCopy | null;
};

/* The running installation's identity; unresolved values take the injected label. */
export function aboutRows(
	runtime: RuntimeInfo | null,
	unavailable: string
): { key: string; value: string }[] {
	return [
		{ key: m.settings_version(), value: runtime?.appVersion ?? unavailable },
		{ key: m.settings_build(), value: runtime?.build ?? unavailable },
		{
			key: m.settings_database_schema(),
			value: runtime?.schemaVersion?.toString() ?? unavailable
		},
		{ key: m.settings_platform(), value: runtime?.platform ?? unavailable }
	];
}

/* Exactly the details the page shows, so Copy never invents a value. */
export function diagnosticText(runtime: RuntimeInfo | null, unavailable: string): string {
	return aboutRows(runtime, unavailable)
		.map((row) => `${row.key}: ${row.value}`)
		.join('\n');
}
