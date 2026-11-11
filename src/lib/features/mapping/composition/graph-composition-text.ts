/**
 * The measured text the composer draws: a Worker's name and a region's
 * heading, with the conservative fallback for anything unmeasured.
 */
import type { TextSize } from '../labels/graph-text-metrics.ts';
import type { ComposerContext } from './graph-composition-context.ts';

export function sizeOfName(ctx: ComposerContext, id: string): TextSize {
	return ctx.text.names.get(id) ?? { width: 80, height: 14 };
}

export function sizeOfHeading(ctx: ComposerContext, key: string): TextSize {
	return ctx.text.headings.get(key) ?? { width: 80, height: 15 };
}
