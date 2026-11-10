/**
 * The native shell's narrow language handoff.
 *
 * The frontend owns the one startup locale resolution; it passes the already-resolved
 * locale and the app-controlled menu labels from the primary catalogs. Rust validates
 * both and rebuilds only the menu. Outside Tauri this is an explicit no-op.
 */
import type { AppLocale } from '#lib/i18n/locale.ts';
import { isTauriTransport } from './transport.ts';

export type NativeMenuLabels = {
	edit: string;
	window: string;
	quit: string;
};

export async function initializeNativeLocale(
	locale: AppLocale,
	labels: NativeMenuLabels
): Promise<void> {
	if (!isTauriTransport()) return;

	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('initialize_native_locale', { locale, labels });
}
