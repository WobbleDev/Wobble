import { afterEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { createAttribute, type AttributeDraft } from './attribute-draft.ts';
import { createAttributePlacement } from './attribute-placement.svelte.ts';

// Pointer dispatch and capture are browser boundaries; the real controller owns the gesture.
function setup(
	target: Element | null = null,
	expand = vi.fn(),
	extra: AttributeDraft[] = [],
	base?: AttributeDraft
) {
	const surface = new EventTarget();
	let hovered = target;
	vi.stubGlobal('window', surface);
	vi.stubGlobal('document', { elementFromPoint: () => hovered });
	let captured = false;
	const handle = Object.assign(new EventTarget(), {
		setPointerCapture: () => {
			captured = true;
		},
		hasPointerCapture: () => captured,
		releasePointerCapture: () => {
			captured = false;
		}
	});
	const attribute =
		base ??
		createAttribute('department', 'Department', 'category', [
			{ id: 'a', value: 'Shipping' },
			{ id: 'b', value: 'Packing', parentId: 'a' },
			{ id: 'c', value: 'Receiving' }
		]);
	const move = vi.fn();
	const moveToAttribute = vi.fn(() => true);
	const promote = vi.fn(() => true);
	const reorderBeside = vi.fn(() => true);
	const placement = createAttributePlacement({
		attributes: [attribute, ...extra],
		root: {
			contains: () => true,
			querySelector: () => null,
			closest: () => null
		} as unknown as HTMLElement,
		disabled: false,
		expandedIds: new Set(),
		expand,
		move,
		moveToAttribute,
		promote,
		reorderBeside,
		create: vi.fn(() => null)
	});
	function pointer(type: string, x: number, pointerType = 'mouse') {
		const event = Object.assign(new Event(type, { cancelable: true }), {
			pointerId: 1,
			pointerType,
			button: 0,
			clientX: x,
			clientY: 0
		});
		Object.defineProperty(event, 'currentTarget', { value: handle });
		return event as unknown as PointerEvent;
	}
	return {
		placement,
		surface,
		handle,
		move,
		moveToAttribute,
		promote,
		reorderBeside,
		pointer,
		captured: () => captured,
		hover: (next: Element | null) => {
			hovered = next;
		}
	};
}
/** A row or zone as the pointer or focus sees it: its nearest placement target. */
function targetElement(attributeId: string, parentId: string, promoteZone = false) {
	const dataset: Record<string, string> = {
		placementAttribute: attributeId,
		placementParent: parentId
	};
	if (promoteZone) dataset.placementPromote = '';
	const element = { dataset, closest: () => element } as unknown as HTMLElement;
	return element;
}
function location() {
	return createAttribute('location', 'Location', 'category', [
		{ id: 'x', value: 'Central' },
		{ id: 'y', value: 'Dock', parentId: 'x' }
	]);
}
// Receiving > Dock > Ramp > Bay > Lane: Lane is five levels deep, Bay four. Packing is a
// separate branch under Shipping, so a drag from Packing can reach the deep levels.
function deepDepartment() {
	return createAttribute('department', 'Department', 'category', [
		{ id: 'a', value: 'Shipping' },
		{ id: 'b', value: 'Packing', parentId: 'a' },
		{ id: 'c', value: 'Receiving' },
		{ id: 'dock', value: 'Dock', parentId: 'c' },
		{ id: 'ramp', value: 'Ramp', parentId: 'dock' },
		{ id: 'bay', value: 'Bay', parentId: 'ramp' },
		{ id: 'lane', value: 'Lane', parentId: 'bay' }
	]);
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function rowElement(targetId: string, top = 100, height = 40) {
	const element = {
		dataset: { reorderRow: targetId, reorderAttribute: 'department' },
		closest: () => element,
		getBoundingClientRect: () => ({ top, height })
	} as unknown as HTMLElement;
	return element;
}

describe('Attribute pointer sibling reorder', () => {
	function drag(rowTarget: HTMLElement, y: number) {
		const ctx = setup(rowTarget);
		ctx.placement.pointerDown(ctx.pointer('pointerdown', 0), {
			kind: 'answer',
			attributeId: 'department',
			answerId: 'a'
		});
		const at = (type: string) => {
			const event = ctx.pointer(type, 20);
			Object.defineProperty(event, 'clientY', { value: y });
			return event;
		};
		return { ...ctx, at };
	}
	it('an edge drop on a sibling reorders and shows the edge', () => {
		const { placement, surface, at, reorderBeside, move } = drag(rowElement('c'), 137);
		surface.dispatchEvent(at('pointermove'));
		expect(placement.dropEdge('c')).toBe('bottom');
		surface.dispatchEvent(at('pointerup'));
		expect(reorderBeside).toHaveBeenCalledWith('department', 'a', 'c', true);
		expect(move).not.toHaveBeenCalled();
		expect(placement.dropEdge('c')).toBeNull();
	});
	it('Escape during the drag cancels without editing', () => {
		const { placement, surface, at, reorderBeside } = drag(rowElement('c'), 102);
		surface.dispatchEvent(at('pointermove'));
		expect(placement.dropEdge('c')).toBe('top');
		placement.cancel();
		expect(placement.dropEdge('c')).toBeNull();
		surface.dispatchEvent(at('pointerup'));
		expect(reorderBeside).not.toHaveBeenCalled();
	});
	it('the middle of a row and non-siblings do not reorder', () => {
		const middle = drag(rowElement('c'), 120);
		middle.surface.dispatchEvent(middle.at('pointermove'));
		expect(middle.placement.dropEdge('c')).toBeNull();
		// b sits under a, so it is not a sibling of a.
		const other = drag(rowElement('b'), 102);
		other.surface.dispatchEvent(other.at('pointermove'));
		expect(other.placement.dropEdge('b')).toBeNull();
	});
});

describe('Attribute placement gesture lifecycle', () => {
	it('keeps a short press as a click, and releases capture and listeners', () => {
		const { placement, pointer, surface, captured, move } = setup();
		placement.pointerDown(pointer('pointerdown', 0), {
			kind: 'answer',
			attributeId: 'department',
			answerId: 'a'
		});
		surface.dispatchEvent(pointer('pointermove', 3));
		expect(placement.source).toBeNull();
		surface.dispatchEvent(pointer('pointerup', 3));
		expect(captured()).toBe(false);
		surface.dispatchEvent(pointer('pointermove', 20));
		expect(placement.source).toBeNull();
		expect(move).not.toHaveBeenCalled();
	});
	it('pointer cancellation releases a thresholded drag without editing', () => {
		const { placement, pointer, surface, captured, move } = setup();
		placement.pointerDown(pointer('pointerdown', 0), {
			kind: 'answer',
			attributeId: 'department',
			answerId: 'a'
		});
		surface.dispatchEvent(pointer('pointermove', 8));
		expect(placement.source).toMatchObject({ kind: 'answer', answerId: 'a' });
		surface.dispatchEvent(pointer('pointercancel', 8));
		expect(captured()).toBe(false);
		expect(placement.source).toBeNull();
		surface.dispatchEvent(pointer('pointerup', 8));
		expect(move).not.toHaveBeenCalled();
	});
	it('lost pointer capture stops the drag and releases its listeners', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface, handle, captured, move } = setup();
		placement.pointerDown(pointer('pointerdown', 0), {
			kind: 'answer',
			attributeId: 'department',
			answerId: 'a'
		});
		surface.dispatchEvent(pointer('pointermove', 8));
		handle.dispatchEvent(new Event('lostpointercapture'));
		expect(captured()).toBe(false);
		expect(placement.source).toBeNull();
		vi.runAllTimers();
		surface.dispatchEvent(pointer('pointerup', 8));
		expect(move).not.toHaveBeenCalled();
	});
	it('does not swallow a later intentional click when a cancelled gesture emits no click', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface } = setup();
		placement.pointerDown(pointer('pointerdown', 0), {
			kind: 'answer',
			attributeId: 'department',
			answerId: 'a'
		});
		surface.dispatchEvent(pointer('pointermove', 8));
		surface.dispatchEvent(pointer('pointercancel', 8));
		vi.runAllTimers();
		placement.clickHandle({ kind: 'answer', attributeId: 'department', answerId: 'a' });
		expect(placement.source).toMatchObject({ kind: 'answer', answerId: 'a' });
	});
	it('expands a collapsed destination after a deliberate hover', () => {
		vi.useFakeTimers();
		const target = {
			dataset: { placementAttribute: 'department', placementParent: 'a' },
			closest: () => target
		} as unknown as HTMLElement;
		const expand = vi.fn();
		const { placement, pointer, surface } = setup(target, expand);
		placement.pointerDown(pointer('pointerdown', 0), {
			kind: 'answer',
			attributeId: 'department',
			answerId: 'b'
		});
		surface.dispatchEvent(pointer('pointermove', 8));
		expect(expand).not.toHaveBeenCalled();
		vi.advanceTimersByTime(500);
		expect(expand).toHaveBeenCalledWith('a');
	});
	it('clears pending destination expansion when the drag is cancelled', () => {
		vi.useFakeTimers();
		const target = {
			dataset: { placementAttribute: 'department', placementParent: 'a' },
			closest: () => target
		} as unknown as HTMLElement;
		const expand = vi.fn();
		const { placement, pointer, surface } = setup(target, expand);
		placement.pointerDown(pointer('pointerdown', 0), {
			kind: 'answer',
			attributeId: 'department',
			answerId: 'b'
		});
		surface.dispatchEvent(pointer('pointermove', 8));
		placement.cancel(false);
		vi.advanceTimersByTime(500);
		expect(expand).not.toHaveBeenCalled();
	});
	it('uses a touch tap to choose a source and consumes its duplicate click', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface } = setup();
		const source = { kind: 'answer', attributeId: 'department', answerId: 'a' } as const;
		placement.pointerDown(pointer('pointerdown', 0, 'touch'), source);
		surface.dispatchEvent(pointer('pointerup', 0, 'touch'));
		expect(placement.source).toEqual(source);
		placement.clickHandle(source);
		expect(placement.source).toEqual(source);
		placement.cancel(false);
		placement.clickHandle(source);
		expect(placement.source).toEqual(source);
	});
	it('keeps touch click suppression through delayed compatibility clicks', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface } = setup();
		const source = { kind: 'answer', attributeId: 'department', answerId: 'a' } as const;
		placement.pointerDown(pointer('pointerdown', 0, 'touch'), source);
		surface.dispatchEvent(pointer('pointerup', 0, 'touch'));
		placement.cancel(false);
		vi.advanceTimersByTime(1);
		placement.clickHandle(source);
		expect(placement.source).toBeNull();
	});

	it('clears pending touch click suppression when a new pointer gesture begins', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface } = setup();
		const source = { kind: 'answer', attributeId: 'department', answerId: 'a' } as const;
		const nextSource = { kind: 'answer', attributeId: 'department', answerId: 'c' } as const;
		placement.pointerDown(pointer('pointerdown', 0, 'touch'), source);
		surface.dispatchEvent(pointer('pointerup', 0, 'touch'));
		placement.cancel(false);
		vi.advanceTimersByTime(1);
		placement.pointerDown(pointer('pointerdown', 0), nextSource);
		surface.dispatchEvent(pointer('pointerup', 0));
		placement.clickHandle(nextSource);
		expect(placement.source).toEqual(nextSource);
	});
});

describe('Attribute placement across Attributes', () => {
	const branch = { kind: 'answer', attributeId: 'department', answerId: 'b' } as const;
	const root = { kind: 'answer', attributeId: 'department', answerId: 'a' } as const;

	it('offers another Attribute row as a destination for a branch', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface, hover } = setup(null, vi.fn(), [location()]);
		placement.pointerDown(pointer('pointerdown', 0), branch);
		hover(targetElement('location', ''));
		surface.dispatchEvent(pointer('pointermove', 8));
		expect(placement.destination).toEqual({ attributeId: 'location', parentId: '' });
		expect(placement.refusal).toBeNull();
	});

	it('refuses its own subtree with a reason, then clears it on a valid target', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface, hover } = setup(null, vi.fn(), [location()]);
		placement.pointerDown(pointer('pointerdown', 0), root);
		hover(targetElement('department', 'b'));
		surface.dispatchEvent(pointer('pointermove', 8));
		expect(placement.destination).toBeNull();
		expect(placement.refusal).toEqual({
			target: { attributeId: 'department', parentId: 'b' },
			reason: m.configuration_move_below_descendant()
		});
		expect(placement.announcement).toBe(
			m.configuration_placement_refused({ reason: m.configuration_move_below_descendant() })
		);
		hover(targetElement('location', 'x'));
		surface.dispatchEvent(pointer('pointermove', 8));
		expect(placement.refusal).toBeNull();
		expect(placement.destination).toEqual({ attributeId: 'location', parentId: 'x' });
	});

	it('refuses a pending new value dragged into another Attribute', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface, hover } = setup(null, vi.fn(), [location()]);
		placement.pointerDown(pointer('pointerdown', 0), {
			kind: 'pending',
			attributeId: 'department',
			value: 'Loading'
		});
		hover(targetElement('location', ''));
		surface.dispatchEvent(pointer('pointermove', 8));
		expect(placement.destination).toBeNull();
		expect(placement.refusal?.reason).toBe(m.configuration_placement_refusal_pending_elsewhere());
	});

	it('moves a branch through the host when it is dropped on another Attribute', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface, hover, moveToAttribute, move } = setup(null, vi.fn(), [
			location()
		]);
		placement.pointerDown(pointer('pointerdown', 0), branch);
		hover(targetElement('location', ''));
		surface.dispatchEvent(pointer('pointermove', 8));
		surface.dispatchEvent(pointer('pointerup', 8));
		expect(moveToAttribute).toHaveBeenCalledWith(
			{ attributeId: 'department', answerId: 'b' },
			{ attributeId: 'location', parentId: '' }
		);
		expect(move).not.toHaveBeenCalled();
		expect(placement.source).toBeNull();
	});

	it('promotes a branch when it is dropped on the promote zone', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface, hover, promote } = setup(null, vi.fn(), [location()]);
		placement.pointerDown(pointer('pointerdown', 0), branch);
		hover(targetElement('', '', true));
		surface.dispatchEvent(pointer('pointermove', 8));
		expect(placement.destination).toEqual({ attributeId: '', parentId: '', promote: true });
		surface.dispatchEvent(pointer('pointerup', 8));
		expect(promote).toHaveBeenCalledWith({ attributeId: 'department', answerId: 'b' });
	});

	it('a refused drop cancels without calling the host and keeps the reason announced', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface, hover, move, moveToAttribute } = setup(null, vi.fn(), [
			location()
		]);
		placement.pointerDown(pointer('pointerdown', 0), root);
		hover(targetElement('department', 'b'));
		surface.dispatchEvent(pointer('pointermove', 8));
		surface.dispatchEvent(pointer('pointerup', 8));
		expect(move).not.toHaveBeenCalled();
		expect(moveToAttribute).not.toHaveBeenCalled();
		expect(placement.source).toBeNull();
		expect(placement.announcement).toBe(
			m.configuration_placement_refused({ reason: m.configuration_move_below_descendant() })
		);
	});

	it('expands a collapsed Attribute row after a deliberate hover', () => {
		vi.useFakeTimers();
		const expand = vi.fn();
		const { placement, pointer, surface, hover } = setup(null, expand, [location()]);
		placement.pointerDown(pointer('pointerdown', 0), branch);
		hover(targetElement('location', ''));
		surface.dispatchEvent(pointer('pointermove', 8));
		expect(expand).not.toHaveBeenCalled();
		vi.advanceTimersByTime(500);
		expect(expand).toHaveBeenCalledWith('location');
	});

	it('refuses a pending value dragged onto the promote zone', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface, hover, promote } = setup(null, vi.fn(), [location()]);
		placement.pointerDown(pointer('pointerdown', 0), {
			kind: 'pending',
			attributeId: 'department',
			value: 'Loading'
		});
		hover(targetElement('', '', true));
		surface.dispatchEvent(pointer('pointermove', 8));
		expect(placement.destination).toBeNull();
		expect(promote).not.toHaveBeenCalled();
	});
});

describe('Attribute placement eligibility at depth four and five', () => {
	const packing = { kind: 'answer', attributeId: 'department', answerId: 'b' } as const;
	const dock = { kind: 'answer', attributeId: 'department', answerId: 'dock' } as const;
	const within = (parentId: string) => ({ attributeId: 'department', parentId });

	it('makes a level-4 and a level-5 answer eligible targets for a branch elsewhere in the Attribute', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface } = setup(null, vi.fn(), [], deepDepartment());
		placement.pointerDown(pointer('pointerdown', 0), packing);
		surface.dispatchEvent(pointer('pointermove', 8));

		expect(placement.source).toMatchObject({ kind: 'answer', answerId: 'b' });
		expect(placement.eligible(within('bay'))).toBe(true);
		expect(placement.eligible(within('lane'))).toBe(true);
	});

	it('refuses the dragged answer as a target, and each of its descendants at depth two to five', () => {
		vi.useFakeTimers();
		const { placement, pointer, surface } = setup(null, vi.fn(), [], deepDepartment());
		placement.pointerDown(pointer('pointerdown', 0), dock);
		surface.dispatchEvent(pointer('pointermove', 8));

		expect(placement.source).toMatchObject({ kind: 'answer', answerId: 'dock' });
		expect(placement.eligible(within('ramp'))).toBe(false);
		expect(placement.eligible(within('bay'))).toBe(false);
		expect(placement.eligible(within('lane'))).toBe(false);
		expect(placement.eligible(within('dock'))).toBe(false);
	});
});
