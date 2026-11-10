import { describe, expect, it } from 'vitest';
import { defaultAppSettings } from '#lib/shared/app-settings.ts';
import {
	applyQueuedSettings,
	POLL_DELAYS,
	pollDelay,
	queueSettingUpdate,
	resolveIsDark
} from './settings-sync.svelte.ts';

describe('pollDelay', () => {
	it('polls after 5, 15 and then every 30 seconds', () => {
		expect(POLL_DELAYS).toEqual([5000, 15000, 30000]);
		expect([0, 1, 2, 3, 10].map(pollDelay)).toEqual([5000, 15000, 30000, 30000, 30000]);
	});
});

describe('resolveIsDark', () => {
	it('follows the system only under the system theme', () => {
		expect(resolveIsDark('dark', false)).toBe(true);
		expect(resolveIsDark('light', true)).toBe(false);
		expect(resolveIsDark('system', true)).toBe(true);
		expect(resolveIsDark('system', false)).toBe(false);
	});
});

describe('queued settings updates', () => {
	it('replaces a repeated setting in place so the last click wins', () => {
		const pending = queueSettingUpdate(queueSettingUpdate([], { theme: 'dark' }), {
			theme: 'light'
		});

		expect(pending).toEqual([{ theme: 'light' }]);
	});

	it('keeps different settings in click order', () => {
		const pending = queueSettingUpdate(queueSettingUpdate([], { theme: 'dark' }), {
			density: 'compact'
		});

		expect(pending).toEqual([{ theme: 'dark' }, { density: 'compact' }]);
	});

	it('leaves another click on a different setting untouched when one repeats', () => {
		const pending = queueSettingUpdate(queueSettingUpdate([], { theme: 'dark' }), {
			density: 'compact'
		});
		const queued = queueSettingUpdate(pending, { theme: 'light' });

		expect(queued).toEqual([{ theme: 'light' }, { density: 'compact' }]);
	});

	it('lays queued clicks over the confirmed reply so a save never flashes an old value', () => {
		const confirmed = { ...defaultAppSettings, theme: 'dark', density: 'compact' } as const;
		const merged = applyQueuedSettings(confirmed, [{ theme: 'light' }, { textSize: '125' }]);

		expect(merged.theme).toBe('light');
		expect(merged.textSize).toBe('125');
		/* A value the queue does not mention keeps the core's confirmed answer. */
		expect(merged.density).toBe('compact');
	});

	it('returns the confirmed reply unchanged when nothing is queued', () => {
		expect(applyQueuedSettings(defaultAppSettings, [])).toBe(defaultAppSettings);
	});
});
