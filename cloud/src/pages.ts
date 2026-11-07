// Marketing homepage and sign-in page for vidcapture.stream.
// Product illustrations are drawn in HTML/CSS from the desktop app's real layout.

const check = '<svg class="mark-yes" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5 8.5 14 15 6.5"/></svg>';
const dash = '<svg class="mark-no" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 10h8"/></svg>';

// Deterministic waveform so every render matches.
function waveform(count: number, seed: number, cutFrom = -1, cutTo = -1) {
	let bars = '', x = seed;
	for (let i = 0; i < count; i++) {
		x = (x * 9301 + 49297) % 233280;
		const speech = 0.35 + 0.65 * Math.abs(Math.sin(i / 5.3) * Math.cos(i / 13.1));
		const pause = i % 41 > 36 ? 0.12 : 1;
		const h = Math.min(12, Math.max(1, Math.round((0.2 + (x / 233280) * 0.8) * speech * pause * 12)));
		bars += `<i class="h${h}${i >= cutFrom && i < cutTo ? ' cut' : ''}"></i>`;
	}
	return bars;
}

function appWindow() {
	return `<figure class="app-shot" aria-label="The VidCapture editor with a recording, its camera bubble, a waveform timeline with one section cut, and a ready share link">
	<div class="app-bar"><span class="app-name"><span class="rec-dot"></span>VidCapture</span><span class="app-tabs"><span>Record</span><span class="on">Edit</span></span><span class="app-win"><i></i><i></i></span></div>
	<div class="app-body">
		<div class="app-file"><strong>Quarterly walkthrough.mp4</strong><span>2560 × 1440, 14:52</span></div>
		<div class="app-stage">
			<div class="screen">
				<div class="screen-side"><i></i><i></i><i></i><i></i><i></i></div>
				<div class="screen-main">
					<div class="screen-title"></div>
					<div class="screen-chart"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
					<div class="screen-rows"><i></i><i></i><i></i></div>
				</div>
				<div class="bubble"><svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="31" r="14"/><path d="M12 80c2-18 13-27 28-27s26 9 28 27z"/></svg></div>
			</div>
		</div>
		<div class="app-row"><span class="app-play"></span><span class="mono">4:18.20 / 13:07.00</span><span class="app-speed">1×</span><span class="app-kept">1 cut, 13:07 kept</span></div>
		<div class="wave" aria-hidden="true">${waveform(120, 7, 52, 66)}<span class="cut-zone z1"></span><span class="playhead"></span></div>
		<div class="app-tools"><span>Cut</span><span>Trim to selection</span><span class="sp"></span><span>Undo</span></div>
		<div class="app-share"><span class="ok">✓</span><span><strong>Your share link is ready</strong><span class="mono">vidcapture.stream/v/9f2c41…</span></span><span class="copy">Copy link</span></div>
	</div>
</figure>`;
}

function pickerShot() {
	return `<div class="pick-shot" aria-hidden="true">
	<div class="pick-desk">
		<div class="pick-win a"><span></span></div>
		<div class="pick-win b selected"><span></span><em>Firefox: Project plan</em></div>
		<div class="pick-win c"><span></span></div>
	</div>
	<div class="pick-bar"><span class="on">Window</span><span>Area</span><span>Display</span><span class="go">Record</span></div>
</div>`;
}

function editShot() {
	return `<div class="edit-shot" aria-hidden="true">
	<div class="wave small">${waveform(64, 3, 22, 31)}<span class="cut-zone z2"></span></div>
	<div class="edit-labels"><span>0:00</span><span>Cut 0:41</span><span>2:10</span></div>
	<div class="edit-actions"><span class="sel">Fast cleanup</span><span>Enhance audio</span><span class="primary">Save edited copy</span></div>
</div>`;
}

function shareShot() {
	return `<div class="share-shot" aria-hidden="true">
	<div class="share-progress"><span>Uploading 64%</span><b><i></i></b></div>
	<div class="share-link"><span class="mono">vidcapture.stream/v/9f2c41e07a…</span><span class="copy">Copy link</span></div>
	<div class="share-viewer"><span class="vplay"></span><b><i></i></b><span>1.5×</span></div>
</div>`;
}

export function homePage(signedIn: boolean) {
	const cta = signedIn ? '<a class="button" href="/library">Open my library</a>' : '<a class="button" href="https://github.com/campeterson41/vidcapture#install">Install on Omarchy</a>';
	return `<main class="home">
<section class="hero">
	<div class="hero-copy">
		<h1>Record it once.<br>Send one link.</h1>
		<p class="lede">VidCapture is a screen recorder for Linux that keeps every recording on your computer, lets you cut it down in seconds, and shares only the version you choose, at the quality you recorded it.</p>
		<div class="hero-actions"><a class="button" href="https://github.com/campeterson41/vidcapture#install">Install on Omarchy</a>${signedIn ? '<a class="button secondary" href="/library">My library</a>' : '<a class="button secondary" href="/login">Sign in</a>'}</div>
		<p class="hero-note">Open-source early release for Omarchy and Hyprland 0.56. Recording and editing work locally. Sharing requires your own configured Cloudflare deployment; public hosted signup is not available.</p>
	</div>
	<div class="hero-visual">${appWindow()}</div>
</section>

<section class="facts" aria-label="At a glance">
	<div><strong>Your files, your disk</strong><p>Recordings save to your own Videos folder. Nothing leaves your computer until you click Share.</p></div>
	<div><strong>Original quality</strong><p>The file you export is the file people watch. The server never re-encodes it.</p></div>
	<div><strong>Hours, not minutes</strong><p>No recording time limit. Share videos up to 12 hours or 20 GB each.</p></div>
	<div><strong>No trackers</strong><p>Watch pages carry no analytics scripts, ads, or third-party cookies.</p></div>
</section>

<section class="features" id="features">
	<div class="section-head">
		<h2>Everything between pressing record and sending the link</h2>
		<p>Three steps, one app. Each one is built to be fast for you and easy for the person watching.</p>
	</div>

	<article class="feature">
		<div class="feature-copy">
			<span class="step">1</span>
			<h3>Record exactly what you mean to show</h3>
			<p>Click a window, drag an area, or pick a whole display, right on your screen. Choose a window and the recording follows it as you move or resize it, so the frame stays on your work.</p>
			<ul>
				<li>Movable camera bubble in three sizes, from cameras up to 4K input</li>
				<li>Microphone and system audio, kept on separate tracks</li>
				<li>Floating controls to pause, resume, and stop without hunting for a window</li>
				<li>Crash-safe recording: takes are written as they happen, then finished into a standard MP4</li>
			</ul>
		</div>
		<div class="feature-visual">${pickerShot()}</div>
	</article>

	<article class="feature">
		<div class="feature-copy">
			<span class="step">2</span>
			<h3>Cut the stumbles before anyone sees them</h3>
			<p>Edit on a waveform timeline, where pauses and false starts are easy to spot. Select a range and cut it, or trim to just the part you need. Every change can be undone.</p>
			<ul>
				<li>Nondestructive: your original recording is never overwritten</li>
				<li>Playback skips removed sections, so you hear the final cut as you edit</li>
				<li>Audio enhancement requires a separately configured runtime and is not bundled in the public source release</li>
				<li>Your original recording stays intact when you save an edited copy</li>
			</ul>
		</div>
		<div class="feature-visual">${editShot()}</div>
	</article>

	<article class="feature">
		<div class="feature-copy">
			<span class="step">3</span>
			<h3>Share with one click</h3>
			<p>Press Share and VidCapture uploads your edited cut, never the raw take, then hands you a link. Anyone can watch it in a browser. They do not need an account.</p>
			<ul>
				<li>Uploads run in parallel parts and resume where they stopped after a dropped connection</li>
				<li>Viewers can seek instantly, change speed up to 3×, use picture in picture, and play full screen</li>
				<li>Rename or remove any video from your library. A removed video's link stops working right away</li>
			</ul>
		</div>
		<div class="feature-visual">${shareShot()}</div>
	</article>
</section>

<section class="how" id="how">
	<div class="section-head">
		<h2>How it works</h2>
		<p>VidCapture splits the job in two. The heavy work happens on your computer. The website does one thing: deliver the file you chose to share.</p>
	</div>
	<ol class="flow">
		<li><span class="flow-where">On your computer</span><h3>Capture</h3><p>A GPU-based recorder captures your screen while the camera, microphone, and system audio are mixed in. Files save to <code>~/Videos/Capture</code>.</p></li>
		<li><span class="flow-where">On your computer</span><h3>Edit and export</h3><p>Cuts are saved as a separate edit plan. Exporting renders a new MP4 and leaves the source alone.</p></li>
		<li><span class="flow-where">In transit</span><h3>Upload</h3><p>The app sends the export in 8 MB parts over HTTPS using its own device key. The site confirms every part arrived at the right size before the video goes live.</p></li>
		<li><span class="flow-where">vidcapture.stream</span><h3>Watch</h3><p>The original MP4 is stored privately and streamed with byte ranges, so viewers can jump to any moment without downloading the whole file.</p></li>
	</ol>
	<div class="how-detail">
		<div>
			<h3>Private library, unlisted links</h3>
			<p>Only you can see your library. Each shared video gets a link built from 192 bits of randomness, which cannot be guessed or found by browsing. Unlisted is not the same as private, though: anyone you send the link to can watch and download the video.</p>
		</div>
		<div>
			<h3>Signing in without a password</h3>
			<p>Your desktop app holds a private device key, and the website only ever stores a fingerprint of it. When you open your library from the app, it creates a single-use sign-in link that expires in 90 seconds and signs this browser in for seven days.</p>
		</div>
		<div>
			<h3>Built on Cloudflare</h3>
			<p>Videos live in private Cloudflare R2 storage, and the site runs on Cloudflare's global network, so links open quickly wherever your viewers are.</p>
		</div>
	</div>
</section>

<section class="compare" id="compare">
	<div class="section-head">
		<h2>How VidCapture compares</h2>
		<p>Most people choose between a hosted recorder that lives in the browser, or a desktop recorder that leaves sharing to them. VidCapture is built to give you the best parts of both.</p>
	</div>
	<div class="table-wrap" tabindex="0" role="region" aria-label="Comparison table">
	<table>
		<thead><tr><th scope="col"><span class="sr-only">Feature</span></th><th scope="col" class="us">VidCapture</th><th scope="col">Hosted recorders</th><th scope="col">Desktop recorders</th></tr></thead>
		<tbody>
			<tr><th scope="row">Native Linux desktop app</th><td class="us">${check}<span>Built for Hyprland</span></td><td>${dash}<span>Usually a browser extension</span></td><td>${check}<span>Often available</span></td></tr>
			<tr><th scope="row">Master recording stays on your computer</th><td class="us">${check}<span>Always</span></td><td>${dash}<span>Lives in their cloud</span></td><td>${check}<span>Yes</span></td></tr>
			<tr><th scope="row">Click-to-pick window that follows moves</th><td class="us">${check}<span>Yes</span></td><td>${dash}<span>Tab or screen</span></td><td>${dash}<span>Varies</span></td></tr>
			<tr><th scope="row">Edit before uploading</th><td class="us">${check}<span>Only the cut is shared</span></td><td>${dash}<span>Usually after upload</span></td><td>${dash}<span>Separate editor</span></td></tr>
			<tr><th scope="row">Shareable link in one click</th><td class="us">${check}<span>Yes</span></td><td>${check}<span>Yes</span></td><td>${dash}<span>Upload it yourself</span></td></tr>
			<tr><th scope="row">Shared at original quality</th><td class="us">${check}<span>Never re-encoded</span></td><td>${dash}<span>Re-encoded for streaming</span></td><td>${dash}<span>Depends on the host</span></td></tr>
			<tr><th scope="row">Recording length</th><td class="us">${check}<span>No limit on recording</span></td><td>${dash}<span>Free plans are often capped</span></td><td>${check}<span>No limit</span></td></tr>
			<tr><th scope="row">No viewer tracking scripts</th><td class="us">${check}<span>Play count only</span></td><td>${dash}<span>Viewer analytics are common</span></td><td>${dash}<span>Depends on the host</span></td></tr>
		</tbody>
	</table>
	</div>
	<div class="not-yet">
		<h3>What VidCapture does not do yet</h3>
		<p>We would rather tell you now. There are no Mac, Windows, or mobile apps. There are no transcripts, captions, comments, password-protected links, or team workspaces. Videos are delivered as the single file you exported, not in multiple streaming qualities, so viewers on slow connections may wait longer for very high resolution video.</p>
	</div>
</section>

<section class="faq" id="faq">
	<div class="section-head"><h2>Questions</h2></div>
	<div class="faq-list">
		<details><summary>Do the people I send a link to need an account?</summary><p>No. Anyone with the link can watch in their browser. Accounts are only for managing your own library.</p></details>
		<details><summary>Does VidCapture upload my recordings automatically?</summary><p>Never. Recordings stay on your computer. A video only leaves when you press Share, and only the edited version you chose is sent.</p></details>
		<details><summary>Can someone find my videos without the link?</summary><p>No. Videos are not listed or searchable, and their links are random enough that they cannot be guessed. Anyone who has the link can watch and download the video, so share it with the people you trust.</p></details>
		<details><summary>What happens when I remove a video?</summary><p>Its link stops working immediately and the stored file is deleted. Your original recording on your computer is not affected. Copies that viewers already downloaded cannot be recalled.</p></details>
		<details><summary>How long can a video be?</summary><p>There is no limit on recording length. Each shared video can be up to 12 hours long and up to 20 GB.</p></details>
		<details><summary>Which browsers can watch?</summary><p>Videos are standard H.264 MP4 files, which modern desktop and mobile browsers can play. The player supports speed control, keyboard shortcuts, picture in picture, and full screen.</p></details>
		<details><summary>What do I need to run VidCapture?</summary><p>A Linux desktop running the Hyprland compositor, such as Omarchy. Other platforms are not supported yet.</p></details>
		<details><summary>How do I sign in to my library?</summary><p>Open VidCapture on your computer and click Video library. Your browser opens your library and stays signed in for seven days. You can also paste the sign-in link on the <a href="/login">sign-in page</a>.</p></details>
	</div>
</section>

<section class="closing">
	<h2>Explain it once. Let the link do the rest.</h2>
	<p>Record on your desktop, keep the good parts, and send something people can watch anywhere.</p>
	<div class="hero-actions center">${cta}<a class="button secondary" href="#features">Explore features</a></div>
</section>
</main>`;
}

export function loginPage() {
	return `<main class="login">
	<section class="login-card">
		<div class="login-mark" aria-hidden="true"><svg viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#375b43"/><path d="M25 18v28l23-14z" fill="#fff"/></svg></div>
		<h1>Sign in to your library</h1>
		<p class="login-lede">Your VidCapture account lives in the desktop app, so there is no password to remember.</p>
		<ol class="login-steps">
			<li><span>1</span><div><strong>Open VidCapture</strong><p>Start the app on the computer you record with.</p></div></li>
			<li><span>2</span><div><strong>Click Video library</strong><p>It is at the top of the Edit view. Your browser opens your library, already signed in.</p></div></li>
		</ol>
		<form id="login-form" class="login-form" novalidate>
			<label for="login-link">Opened the link in another browser? Paste it here.</label>
			<div class="login-row"><input id="login-link" name="link" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://vidcapture.stream/connect#…" aria-describedby="login-status"><button class="button" type="submit" id="login-submit">Sign in</button></div>
			<p id="login-status" class="login-status" role="status" aria-live="polite"></p>
		</form>
		<p class="login-foot">Sign-in links work once and expire after 90 seconds. You stay signed in on this browser for seven days.</p>
	</section>
	<aside class="login-aside">
		<h2>New to VidCapture?</h2>
		<p>VidCapture records your screen and camera on Linux, lets you cut it down, and shares it as one simple link.</p>
		<a class="text-link" href="/#features">See what it does</a>
		<p class="login-viewer">Watching a video someone sent you? You do not need to sign in. Just open the link.</p>
	</aside>
</main>`;
}
