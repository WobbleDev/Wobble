import { createOverviewChartZoom, type ChartZoomHost } from './overview-chart-zoom.ts';

/** Wires the Overview's wheel zoom to the document for the life of the route. */
export function wireOverviewChartZoom(host: ChartZoomHost): void {
	createOverviewChartZoom({
		...host,
		target: document,
		effect: (setup) => {
			$effect(setup);
		}
	});
}
