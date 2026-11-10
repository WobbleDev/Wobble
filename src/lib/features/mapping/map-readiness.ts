type Size = { width: number; height: number };

/** Wait for the chart's own ResizeObserver, not its initial SVG fallback size. */
export function afterMeasuredMapSurface(
	readSizes: () => { surface: Size; svg: Size | undefined },
	frame: () => void
): () => void {
	let frameId: number;
	const check = () => {
		const { surface, svg } = readSizes();
		if (
			svg &&
			surface.width > 0 &&
			surface.height > 0 &&
			Math.abs(svg.width - surface.width) < 1 &&
			Math.abs(svg.height - surface.height) < 1
		) {
			frame();
			return;
		}
		frameId = requestAnimationFrame(check);
	};
	frameId = requestAnimationFrame(check);
	return () => cancelAnimationFrame(frameId);
}
