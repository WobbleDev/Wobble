/**
 * The geometry of the Committee coverage card's flight into the My Committee column,
 * kept apart from the component so it can be read, and tested, without a browser.
 */

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Travel {
	/** Where the column's top-left corner stands on the card, relative to its own place. */
	dx: number;
	dy: number;
	/** How much of the column's right and bottom the card does not cover, in pixels. */
	right: number;
	bottom: number;
}

/**
 * The card's rest place measured from the column. The dashboard's current slide is taken
 * off the card's rect, because at rest the dashboard has not slid: entering it is already
 * zero, leaving it is the full focused slide.
 */
export function travelOf({
	card,
	column,
	slide
}: {
	card: Box;
	column: Box;
	slide: number;
}): Travel {
	return {
		dx: card.left - slide - column.left,
		dy: card.top - column.top,
		right: Math.max(0, column.width - card.width),
		bottom: Math.max(0, column.height - card.height)
	};
}

/** The corner radius the column and the card share: 0.625rem at the root size. */
const RADIUS = '0.625rem';

/**
 * The flight's keyframes, entering or leaving. The column is clipped to the card's size
 * and shifted onto it, then opens to its own place; leaving is the same run backwards.
 * The opacity is full for most of the way so the card never shows through, and goes
 * quickly at the end that touches the dashboard.
 */
export function flightFrames(travel: Travel, entering: boolean): Keyframe[] {
	const onCard: Keyframe = {
		transform: `translate(${travel.dx}px, ${travel.dy}px)`,
		clipPath: `inset(0px ${travel.right}px ${travel.bottom}px 0px round ${RADIUS})`
	};
	const home: Keyframe = { transform: 'none', clipPath: `inset(0px 0px 0px 0px round ${RADIUS})` };
	return entering
		? [
				{ ...onCard, opacity: 0, offset: 0 },
				{ ...onCard, opacity: 1, offset: 0.001 },
				{ ...home, opacity: 1, offset: 1 }
			]
		: [
				{ ...home, opacity: 1, offset: 0 },
				{ ...onCard, opacity: 1, offset: 0.999 },
				{ ...onCard, opacity: 0, offset: 1 }
			];
}

/**
 * Whether motion is reduced, by the same two rules the stylesheets use: the system
 * preference unless the page opts back in to full motion, or the page's own reduce setting.
 */
export function motionReduced(): boolean {
	const motion = document.documentElement.dataset.motion;
	if (motion === 'reduce') return true;
	return motion !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
