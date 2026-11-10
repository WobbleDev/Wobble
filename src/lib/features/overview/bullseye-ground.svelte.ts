import { setBullseyeView } from './bullseye/bullseye-view.ts';

/**
 * The shell's answer to "is the bullseye drawn as a ground, and at what scale?".
 * It publishes that answer to the Overview through the bullseye view context and
 * returns it to the shell, which sizes the ground with the same values.
 *
 * Must run during component initialisation: it sets context and registers an effect.
 *
 * The ground is shown only on the Overview, and only where it can be hovered and
 * moved (`canShow`: wide enough, fine pointer, motion allowed). The zoom is a
 * reading gesture rather than a setting, so it lives only for the visit and
 * returns to the default whenever the Overview is arrived at; crossing the split,
 * or losing a fine pointer or motion, carries it over rather than resetting it.
 */
export function createBullseyeGround(isOverview: () => boolean, canShow: () => boolean) {
	let zoom = $state(1);
	const shown = $derived(isOverview() && canShow());

	setBullseyeView({
		get shown() {
			return shown;
		},
		get zoom() {
			return zoom;
		},
		setZoom(next) {
			zoom = next;
		}
	});
	$effect(() => {
		if (isOverview()) zoom = 1;
	});

	return {
		get shown() {
			return shown;
		},
		get zoom() {
			return zoom;
		}
	};
}
