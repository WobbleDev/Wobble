import { createOverviewWheel, type WheelZoomHost } from './overview-wheel.ts';

/** Wires the Overview's wheel zoom to the document for the life of the route. */
export function wireOverviewWheel(host: WheelZoomHost): void {
	createOverviewWheel({
		...host,
		target: document,
		effect: (setup) => {
			$effect(setup);
		}
	});
}
