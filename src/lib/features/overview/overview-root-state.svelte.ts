import {
	isEnlargedText,
	readRootTheme,
	watchRootAttributes,
	type RootMediaLike,
	type RootObserverLike
} from './overview-root-attributes.ts';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export interface OverviewRootHost {
	readonly root: { readonly dataset: Record<string, string | undefined> };
	createObserver(callback: () => void): RootObserverLike;
	media(query: string): RootMediaLike;
	effect(setup: () => (() => void) | void): void;
}

/**
 * The document-root readings the Overview depends on: enlarged text (the dashboard
 * becomes its own scroller) and the theme and palette the labels read. The host
 * supplies the root, observers, colour-scheme query and effect, so a literal host
 * drives the spec.
 */
export function createOverviewRootState(host: OverviewRootHost) {
	let enlargedText = $state(false);
	let darkTheme = $state(false);
	let colorblindPalette = $state(false);

	host.effect(() =>
		watchRootAttributes(
			{ root: host.root, createObserver: host.createObserver },
			['data-text-size'],
			() => {
				enlargedText = isEnlargedText(host.root.dataset.textSize);
			}
		)
	);

	host.effect(() =>
		watchRootAttributes(
			{ root: host.root, createObserver: host.createObserver, media: host.media(DARK_QUERY) },
			['data-theme', 'data-assessment-palette', 'class'],
			() => {
				const next = readRootTheme(
					host.root.dataset.theme,
					host.root.dataset.assessmentPalette,
					host.media(DARK_QUERY).matches
				);
				darkTheme = next.darkTheme;
				colorblindPalette = next.colorblindPalette;
			}
		)
	);

	return {
		get enlargedText() {
			return enlargedText;
		},
		get darkTheme() {
			return darkTheme;
		},
		get colorblindPalette() {
			return colorblindPalette;
		},
		/** The theme the labels read. */
		get theme(): 'dark' | 'light' {
			return darkTheme ? 'dark' : 'light';
		},
		/** The Assessment palette the segment labels read. */
		get palette(): 'default' | 'colorblind' {
			return colorblindPalette ? 'colorblind' : 'default';
		}
	};
}

/** The route's root state: the real document, observers and colour-scheme query. */
export function overviewRootState() {
	return createOverviewRootState({
		root: document.documentElement,
		createObserver: (callback) => new MutationObserver(callback),
		media: (query) => window.matchMedia(query),
		effect: (setup) => {
			$effect(setup);
		}
	});
}
