'use strict';
// Gmail link expanding. When a VidCapture share link appears in a message being
// written, replace it with the linked title and animated preview, the way Loom's
// extension does. Only the link text is replaced; everything else in the draft
// is left alone. Nothing is recorded or uploaded here.
(() => {
	const ORIGIN = 'https://vidcapture.stream';
	const LINK = /https:\/\/vidcapture\.stream\/v\/([a-f0-9]{48})(?![a-f0-9])/;
	const EDITOR = 'div[contenteditable="true"][role="textbox"], div[contenteditable="true"].editable';
	const SKIP = '[data-vidcapture-card], .gmail_quote, blockquote';
	const cache = new Map(); // share id -> Promise<video|null>
	const pending = new WeakMap(); // editor -> timer

	function lookup(share) {
		if (!cache.has(share)) {
			const watch = `${ORIGIN}/v/${share}`;
			cache.set(share, fetch(`${ORIGIN}/oembed?url=${encodeURIComponent(watch)}&format=json`, {credentials: 'omit'})
				.then(r => (r.ok ? r.json() : null))
				.then(data => (data && data.type === 'video' && data.thumbnail_url ? {
					url: watch,
					title: String(data.title || 'Watch video'),
					gif: `${ORIGIN}/thumbnail/${share}.gif`,
				} : null))
				.catch(() => { cache.delete(share); return null; }));
		}
		return cache.get(share);
	}

	// Matches the website's Copy link card, so emails look the same either way.
	function card(video) {
		const box = document.createElement('div');
		box.setAttribute('data-vidcapture-card', '');
		const link = (style) => { const a = document.createElement('a'); a.href = video.url; a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('style', style); return a; };
		const title = link('font-family:Arial,sans-serif;font-size:18px;font-weight:600;color:#253e2e;text-decoration:underline');
		title.textContent = video.title;
		const imageLink = link('');
		const img = document.createElement('img');
		img.src = video.gif; img.width = 480; img.height = 300; img.alt = `Play ${video.title}`;
		img.setAttribute('style', 'display:block;width:480px;max-width:100%;height:auto;border:0');
		imageLink.append(img);
		const url = link('font-family:Arial,sans-serif;font-size:13px;color:#73786e');
		url.textContent = video.url;
		box.append(title, document.createElement('br'), document.createElement('br'), imageLink, url);
		return box;
	}

	// Links whose visible text is the URL itself. A link someone deliberately
	// labeled ("watch this") is left as they wrote it.
	function candidates(editor) {
		const found = [];
		for (const a of editor.querySelectorAll('a[href]')) {
			const m = LINK.exec(a.href);
			if (m && !a.closest(SKIP) && LINK.test(a.textContent.trim()) && a.textContent.trim().startsWith(m[0])) found.push({node: a, share: m[1], kind: 'anchor'});
		}
		const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const m = LINK.exec(n.data);
			if (m && !n.parentElement.closest('a') && !n.parentElement.closest(SKIP)) found.push({node: n, share: m[1], kind: 'text', match: m});
		}
		return found;
	}

	async function expand(editor) {
		for (const item of candidates(editor)) {
			const video = await lookup(item.share);
			if (!video || !item.node.isConnected) continue; // Private, removed or offline: keep the plain link.
			const box = card(video);
			if (item.kind === 'anchor') item.node.replaceWith(box);
			else {
				const index = item.node.data.indexOf(item.match[0]);
				if (index < 0) continue;
				const rest = item.node.splitText(index);
				rest.data = rest.data.slice(item.match[0].length);
				rest.before(box);
			}
			// Leave the cursor after the card and let Gmail save the draft.
			const after = document.createTextNode(' ');
			box.after(after);
			const selection = window.getSelection();
			if (selection && editor.contains(selection.anchorNode || null)) {
				const range = document.createRange(); range.setStartAfter(after); range.collapse(true);
				selection.removeAllRanges(); selection.addRange(range);
			}
			editor.dispatchEvent(new InputEvent('input', {bubbles: true}));
		}
	}

	function schedule(editor) {
		clearTimeout(pending.get(editor));
		// Short pause so a link being typed is complete; pasted links swap almost at once.
		pending.set(editor, setTimeout(() => expand(editor), 350));
	}

	new MutationObserver(mutations => {
		const seen = new Set();
		for (const m of mutations) {
			const el = m.target.nodeType === Node.TEXT_NODE ? m.target.parentElement : m.target;
			const editor = el && el.closest && el.closest(EDITOR);
			if (editor && !seen.has(editor)) { seen.add(editor); schedule(editor); }
		}
	}).observe(document.documentElement, {childList: true, characterData: true, subtree: true});
})();
