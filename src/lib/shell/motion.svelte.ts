import { MediaQuery } from 'svelte/reactivity';
import type { ReduceMotionPreference } from '#lib/shared/app-settings.ts';

/**
 * Whether motion should be reduced, from the saved Reduce motion preference and the
 * system's own preference. "system" is the only preference that reads the system;
 * "reduce" and "full" are deliberate overrides.
 */
export function resolveReducedMotion(
	preference: ReduceMotionPreference,
	systemPrefersReduced: boolean
): boolean {
	return preference === 'reduce' || (preference === 'system' && systemPrefersReduced);
}

/**
 * The saved preference, kept in step with the app settings by settings-sync. Module
 * state so every component reads the same answer without threading a context.
 */
let preference = $state<ReduceMotionPreference>('system');

/** Created on first read, not at module load: unit specs import this module in node. */
let systemPreference: MediaQuery | undefined;

function systemPrefersReduced(): boolean {
	systemPreference ??= new MediaQuery('(prefers-reduced-motion: reduce)', false);
	return systemPreference.current;
}

/** The current motion decision. Read it from a derived or an effect so it stays live. */
export function reducedMotion(): boolean {
	return resolveReducedMotion(preference, systemPrefersReduced());
}

/** Called by settings-sync whenever the saved Reduce motion setting changes. */
export function setMotionPreference(next: ReduceMotionPreference): void {
	preference = next;
}
