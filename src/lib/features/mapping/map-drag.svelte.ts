/**
 * Dragging on the map: a Worker's dot in a Free map and a group's body in a Grouped one.
 * A press is armed first and becomes a drag only once the pointer travels past a
 * threshold, so a click that wobbles is still a click; a press that did become a drag
 * suppresses the click that follows its release. The canvas owns where dragged dots are
 * remembered and what the arrangement does with the drag; this module owns the gesture.
 */
import { regionKey, type Point } from './layout/graph-layout.ts';

/** Distance in screen pixels a press must travel before it counts as a drag. */
const workerDragThreshold = 4;
/** Pointer travel within this much is a click, not a pan: a dismissal, not a drag. */
const clickTravelThreshold = 4;

/** What the drag reads from the canvas and writes back to it. */
export type MapDragHost = {
	/** Isolate is a focus on the map as it rests: nothing drags there. */
	isolated: () => boolean;
	/** Whether the map is grouped; only a grouped map has group bodies to drag. */
	grouped: () => boolean;
	/** Space held: any press pans, over hulls and dots too. */
	spaceHeld: () => boolean;
	/** The arrangement as drawn, for the group centre a press must find. */
	settled: () => { positions: ReadonlyMap<string, Point>; centres: ReadonlyMap<string, Point> };
	panZoom: () => { toMapPoint: (event: PointerEvent) => Point | undefined };
	/** Keeps a finished Worker move: the canvas adds the delta to its manual geometry. */
	commitWorker: (id: string, delta: Point) => void;
	/** Keeps a finished group move: a rigid translation of the whole group. */
	commitGroup: (key: string, delta: Point) => void;
};

/**
 * A drag is a delta from the press, in map units. The canvas lays that delta over its
 * manual geometry; nothing here (or there) re-solves anything while it travels.
 */
export function createMapDrag(host: MapDragHost) {
	/** The group under the pointer: how far it has travelled from where it was pressed. */
	let draggedGroup = $state<{ key: string; delta: Point } | undefined>(undefined);
	/** A press on a group's hull or label, armed until it moves far enough to count as a drag. */
	let pendingGroup: { key: string; clientX: number; clientY: number; press: Point } | undefined;
	/** Set once a press has become a group drag, so the release is not a click. */
	let groupDragMoved = false;
	/** The dot under the pointer: only it, its name and its path ends travel. */
	let draggedWorker = $state<{ id: string; delta: Point } | undefined>(undefined);
	/** A mouse press on a worker, armed until it moves far enough to count as a drag. */
	let pendingWorker:
		{ id: string; clientX: number; clientY: number; press: Point | undefined } | undefined;
	/** Set once a press has become a drag, so the release is not a click. */
	let workerDragMoved = false;
	/** Where the pointer went down on the surface, so a release can tell the two apart. */
	let surfacePress: { x: number; y: number } | undefined;

	/** A mouse press on a worker is armed; it pins only once the pointer travels. */
	function startWorker(event: PointerEvent, workerId: string) {
		// Touch keeps its pan: a finger that starts on a Worker still pans the map.
		// Isolate is a focus on the map as it rests, so a drag there does nothing.
		if (host.isolated() || event.button !== 0 || host.spaceHeld()) return;
		if (event.pointerType === 'touch') return;
		event.stopPropagation();
		pendingWorker = {
			id: workerId,
			clientX: event.clientX,
			clientY: event.clientY,
			press: host.panZoom().toMapPoint(event)
		};
		workerDragMoved = false;
	}

	/** A press on a top-level group's hull or label; a sub-group press arrives as its parent's. */
	function startGroup(event: PointerEvent, regionId: string) {
		if (host.isolated() || !host.grouped() || event.button !== 0 || host.spaceHeld()) return;
		if (event.pointerType === 'touch') return;
		const key = regionId === regionKey('') ? '' : regionId;
		const centre = host.settled().centres.get(key);
		const press = host.panZoom().toMapPoint(event);
		if (!centre || !press) return;
		event.stopPropagation();
		pendingGroup = { key, clientX: event.clientX, clientY: event.clientY, press };
		groupDragMoved = false;
	}

	function movedBy(press: Point | undefined, event: PointerEvent): Point | undefined {
		const point = host.panZoom().toMapPoint(event);
		return point && press ? { x: point.x - press.x, y: point.y - press.y } : undefined;
	}

	function moveGroup(event: PointerEvent) {
		if (!pendingGroup) return;
		if (!draggedGroup) {
			const travelled = Math.hypot(
				event.clientX - pendingGroup.clientX,
				event.clientY - pendingGroup.clientY
			);
			if (travelled < workerDragThreshold) return;
			groupDragMoved = true;
			draggedGroup = { key: pendingGroup.key, delta: { x: 0, y: 0 } };
		}
		const delta = movedBy(pendingGroup.press, event);
		if (delta) draggedGroup = { key: draggedGroup.key, delta };
	}

	function endGroup() {
		pendingGroup = undefined;
		if (!draggedGroup) return;
		host.commitGroup(draggedGroup.key, draggedGroup.delta);
		draggedGroup = undefined;
		setTimeout(() => (groupDragMoved = false), 0);
	}

	function moveWorker(event: PointerEvent) {
		if (!pendingWorker) return;
		if (!draggedWorker) {
			const travelled = Math.hypot(
				event.clientX - pendingWorker.clientX,
				event.clientY - pendingWorker.clientY
			);
			if (travelled < workerDragThreshold) return;
			workerDragMoved = true;
			draggedWorker = { id: pendingWorker.id, delta: { x: 0, y: 0 } };
		}
		const delta = movedBy(pendingWorker.press, event);
		if (delta) draggedWorker = { id: draggedWorker.id, delta };
	}

	/** On release the dot stays where the drag left it until the next re-layout trigger. */
	function endWorker() {
		pendingWorker = undefined;
		if (!draggedWorker) return;
		host.commitWorker(draggedWorker.id, draggedWorker.delta);
		draggedWorker = undefined;
		// A release off the dot fires no click on it, so clear the flag after the
		// click that might still follow this release would have read it.
		setTimeout(() => (workerDragMoved = false), 0);
	}

	return {
		/** The group body being dragged, in layout coordinates. */
		get draggedGroup() {
			return draggedGroup;
		},
		/** The dot being dragged. */
		get draggedWorker() {
			return draggedWorker;
		},
		startWorker,
		startGroup,
		/** The window's pointer move: advances a Worker drag, then a group drag. */
		move(event: PointerEvent) {
			moveWorker(event);
			moveGroup(event);
		},
		/** The window's pointer release or cancel: ends whichever drag is under way. */
		end() {
			endWorker();
			endGroup();
		},
		/**
		 * A click on a dot: true when it is the release of a drag that moved the dot, so
		 * it must not select. The suppression is spent by the click that reads it.
		 */
		suppressesNodeClick(): boolean {
			if (!workerDragMoved) return false;
			workerDragMoved = false;
			return true;
		},
		/** A press landed on the surface: remembered so the release can tell a click from a pan. */
		pressSurface(event: { clientX: number; clientY: number }) {
			surfacePress = { x: event.clientX, y: event.clientY };
		},
		/** The press was cancelled, so no click will follow it. */
		cancelSurfacePress() {
			surfacePress = undefined;
		},
		/**
		 * A click on the surface: true when it dismisses the open card. A click that ends a
		 * group drag, or a press that travelled (a pan), is not a dismissal.
		 */
		dismissesOnClick(event: { clientX: number; clientY: number }): boolean {
			if (groupDragMoved) {
				groupDragMoved = false;
				return false;
			}
			// Panning is looking around, not dismissing: only a press that stayed
			// put (a click, shaky hand and all) closes the worker card.
			const press = surfacePress;
			surfacePress = undefined;
			return !(
				press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > clickTravelThreshold
			);
		}
	};
}

export type MapDrag = ReturnType<typeof createMapDrag>;
