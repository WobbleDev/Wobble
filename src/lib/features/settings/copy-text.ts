/* The clipboard API is unavailable over plain HTTP in some browsers; the textarea is
   the fallback that still copies what the page shows. */
export async function copyText(text: string): Promise<void> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.setAttribute('readonly', '');
	textarea.style.position = 'fixed';
	textarea.style.opacity = '0';
	document.body.append(textarea);
	textarea.select();
	try {
		if (!document.execCommand('copy')) throw new Error('The browser refused the copy.');
	} finally {
		textarea.remove();
	}
}
