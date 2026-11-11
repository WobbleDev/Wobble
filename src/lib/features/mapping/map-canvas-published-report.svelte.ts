/**
 * The conflict report a settled drawing publishes. While the scene is still moving, the
 * report is the packet's own composition-time reading; once the scene is ready it is
 * re-read from the boxes the renderer drew (see `publishedConflicts`), so a re-placed
 * name or a heading laid out at another camera cannot hide a contact.
 */
import { publishedConflicts, type ReportConflicts } from './layout/graph-layout-quality.ts';
import { reportDrawingInput, type ReportDrawingSource } from './map-canvas-report.ts';

export type PublishedReportHost = {
	/** The drawing is settled: names frozen, camera at rest, nothing dragged. */
	ready: () => boolean;
	/** Which reading of the composition this is: its text source (estimate, then measured). */
	textVersion: () => string | undefined;
	/** The packet's conflicts; undefined when the drawing came without a packet. */
	packetConflicts: () => ReportConflicts | undefined;
	/** What the renderer holds at rest; read only when `ready` is true. */
	source: () => ReportDrawingSource;
};

export function createPublishedReport(host: PublishedReportHost) {
	// The report is read once per composition and text version, in reference coordinates,
	// and then kept: camera moves never re-read it. A cache hit reads no camera state, so
	// the derived value stops depending on it.
	let cache:
		{ packet: ReportConflicts; version: string | undefined; value: ReportConflicts } | undefined;
	const reading = $derived.by(() => {
		const packet = host.packetConflicts();
		if (!packet) return { conflicts: undefined, published: false };
		const version = host.textVersion();
		if (cache && cache.packet === packet && cache.version === version) {
			return { conflicts: cache.value, published: true };
		}
		if (!host.ready()) return { conflicts: packet, published: false };
		const value = publishedConflicts({
			conflicts: packet,
			drawing: reportDrawingInput(host.source())
		});
		cache = { packet, version, value };
		return { conflicts: value, published: true };
	});
	return {
		get conflicts() {
			return reading.conflicts;
		},
		/** The report is the render-time reading, not the packet's. */
		get published() {
			return reading.published;
		}
	};
}
