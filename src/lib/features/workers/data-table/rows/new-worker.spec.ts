import { describe, expect, it, vi } from 'vitest';
import type { Worker } from '#lib/domain-vocabulary.ts';
import { createNewWorker } from './new-worker.svelte.ts';

type Setup = { flush?: boolean; createFails?: boolean; refreshFails?: boolean };

function setup(overrides: Setup = {}) {
	const calls: string[] = [];
	const worker = (id: string, name: string) => ({ id, name }) as unknown as Worker;
	const host = {
		flushDrafts: vi.fn(async () => {
			calls.push('flush');
			return overrides.flush ?? true;
		}),
		create: vi.fn(async (name: string) => {
			calls.push('create');
			if (overrides.createFails) throw new Error('refused');
			return worker('new-1', name);
		}),
		refresh: vi.fn(async () => {
			calls.push('refresh');
			if (overrides.refreshFails) throw new Error('stale');
		}),
		rememberCreated: vi.fn(() => void calls.push('remember')),
		openCreated: vi.fn(async () => void calls.push('openCreated')),
		reportAdded: vi.fn(
			(_name: string, refreshed: boolean) => void calls.push(`report:${refreshed}`)
		),
		reveal: vi.fn(() => void calls.push('reveal')),
		focusTrigger: vi.fn(() => void calls.push('focus'))
	};
	return { flow: createNewWorker(host), host, calls };
}

describe('the New Worker placeholder', () => {
	it('saves the open panel first, then opens the row and brings it into view', async () => {
		const { flow, calls } = setup();
		await flow.begin();
		expect(flow.open).toBe(true);
		expect(calls).toEqual(['flush', 'reveal']);
	});

	it('stays closed when the open panel refuses to save', async () => {
		const { flow, host, calls } = setup({ flush: false });
		await flow.begin();
		expect(flow.open).toBe(false);
		expect(host.reveal).not.toHaveBeenCalled();
		expect(calls).toEqual(['flush']);
	});

	it('does not re-open, or save again, when it is already open', async () => {
		const { flow, host } = setup();
		await flow.begin();
		await flow.begin();
		expect(host.flushDrafts).toHaveBeenCalledTimes(1);
		expect(host.reveal).toHaveBeenCalledTimes(1);
	});

	it('hands focus back to the trigger when cancelled', () => {
		const { flow, calls } = setup();
		flow.cancel();
		expect(flow.open).toBe(false);
		expect(calls).toEqual(['focus']);
	});

	it('opens the record on the created Worker before it closes and reports it', async () => {
		const { flow, host, calls } = setup();
		await flow.begin();
		await flow.create('Ada', {});
		expect(calls).toEqual(['flush', 'reveal', 'create', 'refresh', 'openCreated', 'report:true']);
		expect(flow.open).toBe(false);
		expect(host.reportAdded).toHaveBeenCalledWith(
			'Ada',
			true,
			expect.objectContaining({ id: 'new-1' })
		);
	});

	it('keeps the placeholder and what was typed when the core refuses the create', async () => {
		const { flow, host, calls } = setup({ createFails: true });
		await flow.begin();
		expect(await flow.create('Ada', {})).toBe(false);
		expect(flow.open).toBe(true);
		expect(host.refresh).not.toHaveBeenCalled();
		expect(host.reportAdded).not.toHaveBeenCalled();
		expect(calls).toEqual(['flush', 'reveal', 'create']);
	});

	it('keeps the created Worker reachable when the reload fails, and says it did', async () => {
		const { flow, host, calls } = setup({ refreshFails: true });
		await flow.begin();
		await flow.create('Ada', {});
		expect(calls).toEqual([
			'flush',
			'reveal',
			'create',
			'refresh',
			'remember',
			'openCreated',
			'report:false'
		]);
		expect(host.rememberCreated).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ada' }));
	});

	it('answers true without creating when no placeholder is open', async () => {
		const { flow, host } = setup();
		expect(await flow.create('Ada', {})).toBe(true);
		expect(host.create).not.toHaveBeenCalled();
	});
});
