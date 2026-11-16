/**
 * Marks a scroller with `data-fade-top` / `data-fade-bottom` while rows lie
 * beyond that edge, so `.scroll-fade` (layout.css) can mask the edge only when
 * there is more to see. Re-measures on scroll and when the scroller or its
 * content changes size.
 */
export function scrollFade(node: HTMLElement) {
	function measure() {
		const { scrollTop, scrollHeight, clientHeight } = node;
		node.toggleAttribute('data-fade-top', scrollTop > 1);
		node.toggleAttribute('data-fade-bottom', scrollTop + clientHeight < scrollHeight - 1);
	}

	const observer = new ResizeObserver(measure);
	observer.observe(node);
	// The tab swap replaces the list inside, which resizes the content, not the scroller.
	const mutations = new MutationObserver(() => {
		for (const child of node.children) observer.observe(child);
		measure();
	});
	mutations.observe(node, { childList: true, subtree: true });
	for (const child of node.children) observer.observe(child);
	node.addEventListener('scroll', measure, { passive: true });
	measure();

	return {
		destroy() {
			observer.disconnect();
			mutations.disconnect();
			node.removeEventListener('scroll', measure);
		}
	};
}
