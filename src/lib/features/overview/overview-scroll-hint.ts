/**
 * The Overview dashboard's scroll hint: a plain port of the
 * reference preview's scroll-hint attachment. Applied with `{@attach scrollHint}`
 * on a card's inner scroller, it marks which edges have more content beyond them
 * in `data-left/right/top/bottom`, so the `.scroll-hint` mask in the page fades
 * each clipped edge through 14px (0.875rem). The marks update on scroll and on
 * resize; no backgrounds are added to anything. Styles mark the attribute
 * selectors global so Svelte scoping does not break them.
 */
export function scrollHint(node: HTMLElement): () => void {
	const update = () => {
		const x = node.scrollWidth - node.clientWidth;
		const y = node.scrollHeight - node.clientHeight;
		node.dataset.left = String(node.scrollLeft > 1);
		node.dataset.right = String(x > 1 && node.scrollLeft < x - 1);
		node.dataset.top = String(node.scrollTop > 1);
		node.dataset.bottom = String(y > 1 && node.scrollTop < y - 1);
	};
	update();
	node.addEventListener('scroll', update, { passive: true });
	const observer = new ResizeObserver(update);
	observer.observe(node);
	if (node.firstElementChild) observer.observe(node.firstElementChild);
	return () => {
		node.removeEventListener('scroll', update);
		observer.disconnect();
	};
}
