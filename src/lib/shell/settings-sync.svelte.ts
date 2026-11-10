import { getAppSettings, resetAppSettings, saveAppSettings } from '#lib/client/settings-api.ts';
import { m } from '#lib/paraglide/messages.js';
import { cacheAppearance } from '#lib/client/appearance-cache.ts';
import { cacheLanguage } from '#lib/i18n/language-cache.ts';
import { appliedLocale } from '#lib/i18n/locale.ts';
import { applyAppearanceAttributes } from '#lib/shell/appearance-attributes.ts';
import { setMotionPreference } from '#lib/shell/motion.svelte.ts';
import type {
	AppSettings,
	AppSettingsContext,
	AppSettingsUpdate
} from '#lib/shared/app-settings.ts';

/** Gaps between settings refreshes: soon once, then a slow watch. */
export const POLL_DELAYS = [5000, 15000, 30000];

/** The delay before the next refresh, given how many have already run. */
export function pollDelay(pollCount: number): number {
	return POLL_DELAYS[Math.min(pollCount, POLL_DELAYS.length - 1)];
}

/** Whether the app draws dark, given the saved Theme and the system's preference. */
export function resolveIsDark(theme: AppSettings['theme'], systemPrefersDark: boolean): boolean {
	return theme === 'dark' || (theme === 'system' && systemPrefersDark);
}

/** The one setting a registry update carries; the core accepts exactly one key per PUT. */
function settingKey(update: AppSettingsUpdate): keyof AppSettings {
	return Object.keys(update)[0] as keyof AppSettings;
}

/**
 * The queue after a new click: a repeated setting is replaced in place (last click wins,
 * no interleaved round-trips for one key), while different settings keep their click order.
 */
export function queueSettingUpdate(
	pending: AppSettingsUpdate[],
	update: AppSettingsUpdate
): AppSettingsUpdate[] {
	const key = settingKey(update);
	const index = pending.findIndex((item) => settingKey(item) === key);
	if (index === -1) return [...pending, update];

	return pending.map((item, position) => (position === index ? update : item));
}

/**
 * A saved reply with the still-queued clicks laid back over it, so finishing one request
 * never flashes an older value for a control the reader already moved.
 */
export function applyQueuedSettings(
	confirmed: AppSettings,
	pending: AppSettingsUpdate[]
): AppSettings {
	return pending.reduce<AppSettings>((settings, update) => ({ ...settings, ...update }), confirmed);
}

/**
 * The installation's settings: saving a change, resetting them, refreshing from other
 * windows, and keeping the document's Theme and Density attributes reconciled with them.
 *
 * A click during a save is queued rather than dropped; the control answers immediately and
 * the queue is written one key at a time. A refused write rolls the whole optimistic batch
 * back to the last settings the core confirmed.
 *
 * Call during component initialisation (it registers an effect), and call
 * `start()` from `onMount`; the returned cleanup stops the polling.
 */
export function createSettingsSync(initial: AppSettings) {
	let appSettings = $state<AppSettings>(initial);
	let confirmedSettings = $state<AppSettings>(initial);
	let isSaving = $state(false);
	let saveError = $state('');
	let syncError = $state(false);
	let systemPrefersDark = $state(false);
	let localChangeRevision = 0;
	/* Clicks waiting for the write in flight; not rendered, so not reactive. */
	let pendingUpdates: AppSettingsUpdate[] = [];

	const isDark = $derived(resolveIsDark(appSettings.theme, systemPrefersDark));

	async function flushQueuedSettings(): Promise<void> {
		isSaving = true;

		try {
			while (pendingUpdates.length > 0) {
				const next = pendingUpdates[0];

				try {
					const nextSettings = await saveAppSettings(next);

					/* A newer click on the same setting may have replaced this entry while the
					   request was in flight: remove only the one that was sent, keep the newer
					   one queued, and lay it over the reply. */
					const sentIndex = pendingUpdates.indexOf(next);
					if (sentIndex !== -1) pendingUpdates.splice(sentIndex, 1);

					confirmedSettings = nextSettings;
					appSettings = applyQueuedSettings(nextSettings, pendingUpdates);
					cacheLanguage(nextSettings.language, appliedLocale());
				} catch (error) {
					/* One refused write drops the batch: every queued value was optimistic. */
					pendingUpdates = [];
					appSettings = confirmedSettings;
					saveError = m.shell_settings_save_failed();
					console.error('Could not save app settings.', error);
					return;
				}
			}
		} finally {
			isSaving = false;
		}
	}

	async function updateSetting(update: AppSettingsUpdate): Promise<void> {
		/* Optimistic first: the control moves at once, and a click that lands during a
		   save is queued behind it instead of being ignored. */
		appSettings = { ...appSettings, ...update };
		saveError = '';
		localChangeRevision += 1;
		pendingUpdates = queueSettingUpdate(pendingUpdates, update);

		if (isSaving) return;
		await flushQueuedSettings();
	}

	async function resetSettings(): Promise<void> {
		if (isSaving) return;

		isSaving = true;
		saveError = '';
		localChangeRevision += 1;

		try {
			const nextSettings = await resetAppSettings();

			pendingUpdates = [];
			appSettings = nextSettings;
			confirmedSettings = nextSettings;
			cacheLanguage(nextSettings.language, appliedLocale());
		} catch (error) {
			appSettings = confirmedSettings;
			saveError = m.shell_settings_reset_failed();
			console.error('Could not reset app settings.', error);
		} finally {
			isSaving = false;
		}
	}

	const context: AppSettingsContext = {
		get theme() {
			return appSettings.theme;
		},
		get density() {
			return appSettings.density;
		},
		get reduceMotion() {
			return appSettings.reduceMotion;
		},
		get increaseContrast() {
			return appSettings.increaseContrast;
		},
		get colorBlindAssessments() {
			return appSettings.colorBlindAssessments;
		},
		get textSize() {
			return appSettings.textSize;
		},
		get rememberWindow() {
			return appSettings.rememberWindow;
		},
		get dateFormat() {
			return appSettings.dateFormat;
		},
		get timeFormat() {
			return appSettings.timeFormat;
		},
		get language() {
			return appSettings.language;
		},
		get isDark() {
			return isDark;
		},
		get saving() {
			return isSaving;
		},
		get saveError() {
			return saveError;
		},
		get syncError() {
			return syncError;
		},
		update: updateSetting,
		reset: resetSettings
	};

	$effect(() => {
		// The document's own attributes are the first-paint script's job; this keeps
		// them (and the next first paint's cache) reconciled with the saved settings.
		// Reset rewrites this cache through the same effect, so the next paint is right.
		cacheAppearance(appSettings);
		document.documentElement.classList.toggle('dark', isDark);
		setMotionPreference(appSettings.reduceMotion);
		// One helper owns all six appearance attributes, so the live page and the
		// first-paint cache cannot drift apart.
		applyAppearanceAttributes(appSettings, document.documentElement);
	});

	/** Begin following the system colour scheme and refreshing; returns the cleanup. */
	function start(): () => void {
		const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
		systemPrefersDark = colorScheme.matches;
		const onColorSchemeChange = (event: MediaQueryListEvent) => {
			systemPrefersDark = event.matches;
		};
		colorScheme.addEventListener('change', onColorSchemeChange);

		// Settings are shared across the installation, so a refresh matters — but only
		// while someone is looking at it. Poll soon once, then fall back to a slow
		// watch, and stop entirely while the window is hidden.
		let stopped = false;
		let pollCount = 0;
		let timer: ReturnType<typeof setTimeout>;

		function schedulePoll() {
			if (stopped || document.visibilityState === 'hidden') return;
			timer = setTimeout(() => void pollSettings(), pollDelay(pollCount));
		}

		async function pollSettings() {
			if (document.visibilityState === 'hidden') return;

			const requestRevision = localChangeRevision;

			try {
				const nextSettings = await getAppSettings();

				confirmedSettings = nextSettings;
				if (!isSaving && requestRevision === localChangeRevision) appSettings = nextSettings;
				cacheLanguage(nextSettings.language, appliedLocale());
				syncError = false;
			} catch (error) {
				if (!syncError) console.error('Could not refresh app settings.', error);
				syncError = true;
			} finally {
				pollCount += 1;
				schedulePoll();
			}
		}

		function onVisibilityChange() {
			if (document.visibilityState !== 'visible') return;

			pollCount = 0;
			clearTimeout(timer);
			timer = setTimeout(() => void pollSettings(), 0);
		}

		document.addEventListener('visibilitychange', onVisibilityChange);
		timer = setTimeout(() => void pollSettings(), 1000);

		return () => {
			stopped = true;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', onVisibilityChange);
			colorScheme.removeEventListener('change', onColorSchemeChange);
		};
	}

	return { context, start };
}
