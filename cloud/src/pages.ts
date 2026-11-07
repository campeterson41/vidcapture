// Marketing homepage and sign-in page for vidcapture.stream.
// Product illustrations are drawn in HTML/CSS from the desktop app's current layout.

const check = '<svg class="mark-yes" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5 8.5 14 15 6.5"/></svg>';
const dash = '<svg class="mark-no" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 10h8"/></svg>';

const repo = 'https://github.com/campeterson41/vidcapture';

// Small line icons matching the desktop app's record panel.
const icon = (d: string) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ic = {
	screen: icon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
	window: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>'),
	area: icon('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>'),
	camera: icon('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
	mic: icon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
	speaker: icon('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'),
	sliders: icon('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
	eye: icon('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>'),
	folder: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
	chevron: icon('<path d="m7 10 5 5 5-5"/>'),
	x: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
	check: icon('<path d="m6 12.5 4 4 8-9"/>'),
	link: icon('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
	cut: icon('<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5 20 17M8 15.5 20 7"/>'),
};
const brandMark = '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#375b43"/><path d="M25 18v28l23-14z" fill="#fff"/></svg>';
const person = '<svg class="person" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="31" r="14"/><path d="M12 80c2-18 13-27 28-27s26 9 28 27z"/></svg>';

// A tiny drawn screen used inside thumbnails.
const miniScreen = (variant: string) => `<span class="mini ${variant}"><i></i><i></i><i></i><i></i></span>`;

// The record panel dropping down from the Omarchy top bar.
function heroDesk() {
	return `<figure class="desk" aria-label="The VidCapture record panel open below its top bar icon, with Full screen selected, two displays, a camera, a microphone with a level meter, and a Start recording button">
	<div class="topbar" aria-hidden="true"><span class="ws"><b>1</b><b>2</b><b>3</b></span><span class="clock">Tuesday 9:41</span><span class="tray"><i></i><i></i><span class="tray-app">${brandMark}</span><i></i><i></i></span></div>
	<div class="desk-bg" aria-hidden="true"><span class="bg-win w1"><i></i><i></i><i></i></span><span class="bg-win w2"><i></i><i></i></span></div>
	<div class="panel" aria-hidden="true">
		<div class="panel-head">${brandMark}<strong>VidCapture</strong><span class="panel-link">${ic.folder}Recordings</span>${ic.x}</div>
		<div class="seg3"><span class="on">${ic.screen}Full screen</span><span>${ic.window}Window</span><span>${ic.area}Area</span></div>
		<div class="displays">
			<span class="disp on">${miniScreen('a')}<em>${ic.check}</em><b>Laptop display</b><small class="mono">1920 × 1080</small></span>
			<span class="disp">${miniScreen('b')}<b>Studio display</b><small class="mono">3440 × 1440</small></span>
		</div>
		<div class="prow">${ic.camera}<span>USB camera</span>${ic.chevron}<span class="eye">${ic.eye}</span></div>
		<div class="prow">${ic.mic}<span>Default microphone</span><span class="meter"><i></i></span>${ic.chevron}</div>
		<div class="prow">${ic.speaker}<span>System audio</span><span class="toggle on"></span></div>
		<div class="prow">${ic.sliders}<span>More settings</span>${ic.chevron}</div>
		<div class="start"><span></span>Start recording</div>
	</div>
</figure>`;
}

// Live studio settings with the camera bubble beside them.
function studioShot() {
	const row = (label: string, opts: string[], on: number) => `<div class="srow"><span>${label}</span><span class="seg">${opts.map((o, i) => `<i${i === on ? ' class="on"' : ''}>${o}</i>`).join('')}</span></div>`;
	return `<div class="studio-shot" aria-hidden="true">
	<div class="studio-card">
		<b class="studio-h">Microphone</b>
		${row('Noise removal', ['Off', 'On'], 1)}
		${row('Voice gate', ['Off', 'Gentle', 'Strong'], 1)}
		${row('Rumble filter', ['Off', 'On'], 1)}
		${row('Backup track', ['On', 'Off'], 0)}
		<b class="studio-h">Camera</b>
		${row('Background', ['Original', 'Blur', 'Image'], 1)}
	</div>
	<div class="bubble-demo"><span class="blurbg"><i></i><i></i><i></i></span>${person}</div>
</div>`;
}

// Deterministic waveform so every render matches.
function waveform(count: number, seed: number, cuts: [number, number][] = []) {
	let bars = '', x = seed;
	for (let i = 0; i < count; i++) {
		x = (x * 9301 + 49297) % 233280;
		const speech = 0.35 + 0.65 * Math.abs(Math.sin(i / 5.3) * Math.cos(i / 13.1));
		const pause = i % 41 > 36 ? 0.12 : 1;
		const h = Math.min(12, Math.max(1, Math.round((0.2 + (x / 233280) * 0.8) * speech * pause * 12)));
		const cut = cuts.some(([a, b]) => i >= a && i < b);
		bars += `<i class="h${h}${cut ? ' cut' : ''}"></i>`;
	}
	return bars;
}




export function homePage(signedIn: boolean) {
	const second = signedIn ? '<a class="button secondary" href="/library">My library</a>' : '<a class="button secondary" href="/login#signup">Create a free account</a>';
	return `<main class="home">
<section class="hero">
	<div class="hero-copy">
		<h1>Record a polished video from your top bar.</h1>
		<p class="lede">VidCapture is a screen and camera recorder for Omarchy. It cleans up your microphone while you talk, lets you edit by deleting words from the transcript, and shares the version you choose with one link.</p>
		<div class="hero-actions"><a class="button" href="#install">Install on Omarchy</a>${second}</div>
		<p class="hero-note">Free and open source. Everything stays on your computer until you press Share.</p>
	</div>
	<div class="hero-visual">${heroDesk()}</div>
</section>

<section class="facts" aria-label="At a glance">
	<div><strong>Local first</strong><p>Recording, cleanup, transcripts, and edits all run on your computer.</p></div>
	<div><strong>Original quality</strong><p>The file you save is the file people watch. It is never re-encoded.</p></div>
	<div><strong>No time limit</strong><p>Record for hours. Share videos up to 12 hours or 20 GB each.</p></div>
	<div><strong>Free and open</strong><p>MIT licensed. A free account includes 5 GB, or host sharing yourself.</p></div>
</section>

<section class="features" id="features">
	<div class="section-head">
		<h2>Everything between pressing record and sending the link</h2>
		<p>VidCapture started as a recorder. It now handles the whole job: a clean take, a quick edit, and a link that looks right wherever you paste it.</p>
	</div>

	<article class="feature">
		<div class="feature-copy">
			<h3>Start from the top bar</h3>
			<p>Click the VidCapture icon and a record panel drops down, right where you are. Pick a full screen, a window, or an area, check your camera and microphone, and press Start recording.</p>
			<ul>
				<li>Live thumbnails of every display and window, including windows on other workspaces</li>
				<li>Window recordings follow the window as you move or resize it</li>
				<li>A mic level meter and a 3, 2, 1 countdown, so you know the take will work</li>
				<li>The top bar shows the elapsed time; click it to pause or stop</li>
				<li>Crash safe: takes are written as they happen, then saved as a standard MP4</li>
			</ul>
		</div>
		<div class="feature-visual">${heroDeskMini()}</div>
	</article>

	<article class="feature">
		<div class="feature-copy">
			<h3>Sound and look good while you record</h3>
			<p>Studio settings clean up your microphone live, so the take is already clear when you press stop. The camera bubble gets the same care.</p>
			<ul>
				<li>Noise removal, a voice gate that quiets the gaps between words, and a rumble filter</li>
				<li>Your untouched microphone is kept as a backup track, so cleanup never costs you the original</li>
				<li>A camera bubble up to 4K, with every control your camera offers, remembered for each camera</li>
				<li>Background blur or your own background image, on an NVIDIA GPU</li>
			</ul>
		</div>
		<div class="feature-visual">${studioShot()}</div>
	</article>

	<article class="feature">
		<div class="feature-copy">
			<h3>Edit the video by editing the words</h3>
			<p>Every recording gets a word-by-word transcript, made on your computer. Click a word to jump there. Select a sentence and delete it, and that part of the video is gone.</p>
			<ul>
				<li>Remove filler words cuts every "um" and "uh" at the quiet moment around it</li>
				<li>A waveform timeline for exact cuts and trims, with undo</li>
				<li>Save version renders a new MP4. Your original recording is never changed</li>
			</ul>
		</div>
		<div class="feature-visual"><img class="shot" src="/shots/editor.webp" width="1200" height="780" alt="The VidCapture editor with a recording open, its transcript with cut words crossed out, and a waveform timeline with one section cut" loading="lazy" decoding="async"></div>
	</article>

	<article class="feature">
		<div class="feature-copy">
			<h3>Every take and version, already named</h3>
			<p>The library keeps each recording with all of its versions. Titles are written from what you said, so last week's walkthrough is easy to find.</p>
			<ul>
				<li>Versions fold under each recording, and any of them can be restored</li>
				<li>Shared videos remember their link, so sharing again never uploads twice</li>
				<li>Files are plain MP4s in <code>~/Videos/Capture</code>, ready for any other tool</li>
			</ul>
		</div>
		<div class="feature-visual"><img class="shot" src="/shots/library-grid.webp" width="1000" height="410" alt="The VidCapture library with recordings shown as thumbnails with their lengths and sizes" loading="lazy" decoding="async"></div>
	</article>

	<article class="feature">
		<div class="feature-copy">
			<h3>One link that looks right everywhere</h3>
			<p>Press Share and VidCapture uploads the version you chose, then copies the link. Viewers open it in any browser, with no account and nothing to install.</p>
			<ul>
				<li>Links show a large preview in Slack and LinkedIn, and play in place where video embeds are supported</li>
				<li>Copy link also adds an animated preview card for email</li>
				<li>Viewers can comment or react at an exact moment, without an account, and turn on captions made from your transcript</li>
				<li>You get an email when someone comments, and can turn that off</li>
				<li>Make any video public or private, or remove it and its link stops working right away</li>
				<li>A Chrome extension shows VidCapture links as animated previews in Gmail and starts a recording from the toolbar</li>
			</ul>
		</div>
		<div class="feature-visual"><img class="shot" src="/shots/watch-comments.webp" width="1000" height="1073" alt="A shared video playing on its watch page, with timestamped comments below" loading="lazy" decoding="async"></div>
	</article>
</section>

<section class="how" id="privacy">
	<div class="section-head">
		<h2>Your computer does the work</h2>
		<p>The website does one job: deliver the videos you choose to share. Everything else happens on your machine.</p>
	</div>
	<div class="split">
		<div class="split-col local">
			<h3>Stays on your computer</h3>
			<ul>
				<li>Every recording and every version</li>
				<li>Microphone cleanup and camera effects</li>
				<li>Transcripts, made locally with NVIDIA Parakeet</li>
				<li>Edit plans, titles, and your settings</li>
			</ul>
		</div>
		<div class="split-col cloud">
			<h3>Goes to vidcapture.stream</h3>
			<ul>
				<li>Only the videos you press Share on</li>
				<li>Their preview images and titles</li>
				<li>Play counts and viewer comments</li>
				<li>Nothing else, and nothing in the background</li>
			</ul>
		</div>
	</div>
	<div class="how-detail">
		<div>
			<h3>Links nobody can guess</h3>
			<p>Each video gets a link built from 192 bits of randomness. Videos are never listed or searchable. Private videos play only for you, and you can switch either way at any time.</p>
		</div>
		<div>
			<h3>No trackers on watch pages</h3>
			<p>Viewers get the video, not analytics scripts, ads, or third-party cookies. The only thing counted is plays.</p>
		</div>
		<div>
			<h3>Optional writing help</h3>
			<p>If the Claude Code command line tool is installed and signed in, VidCapture uses it to punctuate transcripts and write titles. It sends transcript text only, never audio or video, through your own account. Set <code>CAPTURE_POLISH=off</code> to turn it off.</p>
		</div>
	</div>
</section>

<section class="compare" id="compare">
	<div class="section-head">
		<h2>How VidCapture compares</h2>
		<p>Most people choose between a hosted recorder that lives in the browser and a desktop recorder that leaves editing and sharing to them.</p>
	</div>
	<div class="table-wrap" tabindex="0" role="region" aria-label="Comparison table">
	<table>
		<thead><tr><th scope="col"><span class="sr-only">Feature</span></th><th scope="col" class="us">VidCapture</th><th scope="col">Hosted recorders</th><th scope="col">Desktop recorders</th></tr></thead>
		<tbody>
			<tr><th scope="row">Native Linux desktop app</th><td class="us">${check}<span>Built for Omarchy</span></td><td>${dash}<span>Browser or Mac and Windows</span></td><td>${check}<span>Often available</span></td></tr>
			<tr><th scope="row">Recordings stay on your computer</th><td class="us">${check}<span>Always</span></td><td>${dash}<span>Uploaded as you record</span></td><td>${check}<span>Yes</span></td></tr>
			<tr><th scope="row">Live noise removal while recording</th><td class="us">${check}<span>With a backup track</span></td><td>${dash}<span>Varies</span></td><td>${dash}<span>Usually filters to set up</span></td></tr>
			<tr><th scope="row">Edit by deleting words</th><td class="us">${check}<span>Transcribed on your computer</span></td><td>${dash}<span>Often a paid feature</span></td><td>${dash}<span>Rarely</span></td></tr>
			<tr><th scope="row">Remove filler words in one step</th><td class="us">${check}<span>Yes</span></td><td>${dash}<span>Often a paid feature</span></td><td>${dash}<span>Rarely</span></td></tr>
			<tr><th scope="row">Shareable link in one click</th><td class="us">${check}<span>Yes</span></td><td>${check}<span>Yes</span></td><td>${dash}<span>Upload it yourself</span></td></tr>
			<tr><th scope="row">Shared at original quality</th><td class="us">${check}<span>Never re-encoded</span></td><td>${dash}<span>Re-encoded for streaming</span></td><td>${dash}<span>Depends on the host</span></td></tr>
			<tr><th scope="row">Comments at a moment in the video</th><td class="us">${check}<span>No viewer account needed</span></td><td>${check}<span>Usually requires sign-in</span></td><td>${dash}<span>Not included</span></td></tr>
			<tr><th scope="row">No viewer tracking scripts</th><td class="us">${check}<span>Play count only</span></td><td>${dash}<span>Viewer analytics are common</span></td><td>${dash}<span>Depends on the host</span></td></tr>
			<tr><th scope="row">Open source</th><td class="us">${check}<span>MIT licensed</span></td><td>${dash}<span>Rarely</span></td><td>${dash}<span>Sometimes</span></td></tr>
		</tbody>
	</table>
	</div>
	<div class="not-yet">
		<h3>What VidCapture does not do yet</h3>
		<p>There are no Mac, Windows, or mobile apps, and no AUR package yet. VidCapture targets Omarchy with Hyprland 0.56, and has been tested on a small range of hardware, so expect rough edges. Background effects need an NVIDIA GPU. There are no password-protected links, team workspaces, or multiple streaming qualities.</p>
	</div>
</section>

<section class="install" id="install">
	<div class="section-head">
		<h2>Get started</h2>
		<p>VidCapture is an early source release for Omarchy. Install the prerequisites listed in the <a href="${repo}#install">README</a>, then build and install:</p>
	</div>
	<div class="install-grid">
		<pre class="code"><code>git clone ${repo}.git
cd vidcapture
./engine/build.sh
./engine/build-camera.sh
./install.sh</code></pre>
		<ol class="steps-list">
			<li><h3>Record</h3><p>Click the VidCapture icon in the top bar, or open it from the launcher.</p></li>
			<li><h3>Add what you want</h3><p>Transcripts, background effects, and noise removal each install separately with one command. The app tells you which.</p></li>
			<li><h3>Share</h3><p>The first time you press Share, vidcapture.stream opens so you can create a free account and connect the app.</p></li>
		</ol>
	</div>
</section>

<section class="faq" id="faq">
	<div class="section-head"><h2>Questions</h2></div>
	<div class="faq-list">
		<details><summary>Is VidCapture free?</summary><p>Yes. The app is open source under the MIT license, and a vidcapture.stream account is free with 5 GB of storage. You can also <a href="${repo}/blob/main/docs/sharing.md">run the sharing server in your own Cloudflare account</a>.</p></details>
		<details><summary>Do the people I send a link to need an account?</summary><p>No. Anyone with the link to a public video can watch and comment in their browser. Private videos only play for you.</p></details>
		<details><summary>Can viewers leave comments?</summary><p>Yes. Anyone who can watch a video can comment or react without an account, pinned to the moment they were watching. You get an email when someone comments, and you can delete any comment or turn comments off for a video.</p></details>
		<details><summary>Does VidCapture upload my recordings automatically?</summary><p>Never. A video only leaves your computer when you press Share, and only the version you chose is sent.</p></details>
		<details><summary>Does transcription send my audio anywhere?</summary><p>No. Transcripts are made on your computer with NVIDIA Parakeet, running on the CPU. If Claude Code is installed, transcript text (never audio) is used for punctuation and titles; you can turn that off.</p></details>
		<details><summary>Do I need an NVIDIA GPU?</summary><p>Only for background blur and background images. Recording, noise removal, transcripts, and editing work without one.</p></details>
		<details><summary>Can someone find my videos without the link?</summary><p>No. Videos are not listed or searchable, and their links cannot be guessed. Anyone who has the link to a public video can watch and download it, so share it with people you trust.</p></details>
		<details><summary>What happens when I remove a video?</summary><p>Its link stops working immediately and the stored file is deleted. The recording on your computer is not affected. Copies that viewers already downloaded cannot be recalled.</p></details>
		<details><summary>How long can a video be?</summary><p>There is no limit on recording length. Each shared video can be up to 12 hours long and up to 20 GB.</p></details>
		<details><summary>What do I need to run VidCapture?</summary><p>Omarchy with Hyprland 0.56, plus GPU Screen Recorder and the other prerequisites in the <a href="${repo}#install">README</a>. Other desktops and platforms are not supported yet.</p></details>
		<details><summary>How do I sign in to my library?</summary><p><a href="/login">Log in</a> with your email and password, or click Video library in VidCapture to open it already signed in.</p></details>
	</div>
</section>

<section class="closing">
	<h2>Explain it once. Let the link do the rest.</h2>
	<p>Record from your top bar, cut what you did not mean to say, and send something people can watch anywhere.</p>
	<div class="hero-actions center"><a class="button" href="#install">Install on Omarchy</a>${signedIn ? '<a class="button secondary" href="/library">Open my library</a>' : '<a class="button secondary" href="/login#signup">Create a free account</a>'}</div>
</section>
</main>`;
}

// A compact window and area picker for the first feature.
function heroDeskMini() {
	return `<div class="pick-shot" aria-hidden="true">
	<div class="pick-desk">
		<span class="pick-win a"><span></span></span>
		<span class="pick-win b selected"><span></span><em>Project plan</em></span>
		<span class="pick-win c"><span></span></span>
	</div>
	<div class="pick-bar"><span class="time"><i></i>4:12</span><span>Pause</span><span class="stop">Stop and save</span></div>
</div>`;
}

export function loginPage() {
	return `<main class="login">
	<section class="login-card">
		<div class="login-mark" aria-hidden="true"><svg viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#375b43"/><path d="M25 18v28l23-14z" fill="#fff"/></svg></div>
		${authPanel('Welcome to VidCapture')}
	</section>
	<aside class="login-aside">
		<h2>Free to start</h2>
		<p>Record on your computer, cut it down, and share one link. Every account includes 5 GB of storage.</p>
		<a class="text-link" href="https://github.com/campeterson41/vidcapture#install">Get the desktop app</a>
		<p class="login-viewer">Watching a video someone sent you? You do not need an account. Just open the link.</p>
	</aside>
</main>`;
}

// Log in / Sign up tabs, shared by the login page and the app connection page.
function authPanel(heading: string) {
	return `<h1>${heading}</h1>
		<div class="tabs" role="tablist" aria-label="Account">
			<button type="button" role="tab" id="tab-login" aria-controls="panel-login" aria-selected="true">Log in</button>
			<button type="button" role="tab" id="tab-signup" aria-controls="panel-signup" aria-selected="false">Sign up</button>
		</div>
		<form id="panel-login" class="auth-form" role="tabpanel" aria-labelledby="tab-login" novalidate>
			<label for="login-email">Email</label><input id="login-email" type="email" autocomplete="email" required>
			<label for="login-password">Password</label><input id="login-password" type="password" autocomplete="current-password" required>
			<button class="button" type="submit">Log in</button>
			<p class="auth-links"><a href="/forgot">Forgot password?</a> <span class="dot">·</span> <button type="button" class="text-button" id="email-link">Email me a sign-in link</button></p>
			<p class="login-status" role="status" aria-live="polite"></p>
		</form>
		<form id="panel-signup" class="auth-form" role="tabpanel" aria-labelledby="tab-signup" hidden novalidate>
			<label for="signup-email">Email</label><input id="signup-email" type="email" autocomplete="email" required>
			<label for="signup-password">Password</label><input id="signup-password" type="password" autocomplete="new-password" minlength="10" required aria-describedby="signup-hint">
			<p id="signup-hint" class="field-hint">At least 10 characters.</p>
			<button class="button" type="submit">Create free account</button>
			<p class="field-hint">By creating an account you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy policy</a>.</p>
			<p class="login-status" role="status" aria-live="polite"></p>
		</form>`;
}

const card = (body: string) => `<main class="login single"><section class="login-card">${body}</section></main>`;
type Page = { title: string; body: string; nav: 'app' | 'viewer'; bodyClass?: string; signedIn?: boolean; admin?: boolean };
export const accountPages: Record<string, Page> = {
	'/connect-app': { title: 'Connect VidCapture', nav: 'viewer', bodyClass: 'page-login', body: `<main class="login single"><section class="login-card" id="connect-app">
		<div id="connect-auth" hidden>${authPanel('Connect VidCapture')}<p class="field-hint">Log in or create a free account to share from VidCapture on your computer.</p></div>
		<div id="connect-verify" hidden><h1>Confirm your email</h1><p class="login-lede">We sent a link to <strong id="verify-to"></strong>. Open it, then come back here. This page continues on its own.</p><button class="quiet" id="connect-resend" type="button">Send it again</button></div>
		<form id="connect-approve" class="auth-form" hidden novalidate><h1>Connect this computer?</h1><p class="login-lede">VidCapture on <strong id="pair-name"></strong> will share videos to <strong id="pair-account"></strong>.</p><label for="pair-code">Type the code VidCapture shows</label><input id="pair-code" class="pair-code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="XXXX-XXXX" required><p class="field-hint">Only connect a computer you are using right now. If someone sent you this link, close this page.</p><div class="actions"><button class="button" id="pair-approve" type="submit">Connect</button><a class="button-link" href="/library">Not now</a></div></form>
		<div id="connect-done" hidden><h1>VidCapture is connected.</h1><p class="login-lede">Go back to the app. Your upload continues on its own.</p><a class="text-link" href="/library">Open my library</a></div>
		<p id="connect-status" class="login-status" role="status" aria-live="polite"></p></section></main>` },
	'/forgot': { title: 'Reset password', nav: 'viewer', bodyClass: 'page-login', body: card(`<h1>Reset your password</h1><p class="login-lede">Enter your account email and we will send you a link to choose a new password.</p><form id="forgot-form" class="auth-form" novalidate><label for="forgot-email">Email</label><input id="forgot-email" type="email" autocomplete="email" required><button class="button" type="submit">Send reset link</button><p class="login-status" role="status" aria-live="polite"></p></form><p class="auth-links"><a href="/login">Back to log in</a></p>`) },
	'/reset': { title: 'Choose a new password', nav: 'viewer', bodyClass: 'page-login', body: card(`<h1>Choose a new password</h1><form id="reset-form" class="auth-form" novalidate><label for="reset-password">New password</label><input id="reset-password" type="password" autocomplete="new-password" minlength="10" required><p class="field-hint">At least 10 characters.</p><button class="button" type="submit">Save password</button><p class="login-status" role="status" aria-live="polite"></p></form>`) },
	'/verify': { title: 'Confirm email', nav: 'viewer', bodyClass: 'page-login', body: card(`<h1 id="verify-heading">Confirming your email…</h1><p id="verify-status" class="login-lede" role="status"></p><a class="button" href="/library" id="verify-continue" hidden>Open my library</a>`) },
	'/account': { title: 'Account', nav: 'app', signedIn: true, body: `<main class="library account-page"><div class="page-heading"><div><h1>Account</h1><p class="subtle" id="account-email"></p></div><div class="actions"><button id="logout" class="quiet" type="button">Log out</button></div></div>
		<section class="account-section"><h2>Storage</h2><p id="account-storage" class="subtle"></p><progress id="account-storage-bar" max="100" value="0"></progress></section>
		<section class="account-section" id="account-verify" hidden><h2>Confirm your email</h2><p>Confirm your address to start sharing. Check your inbox for our email.</p><button class="quiet" id="verify-resend" type="button">Send it again</button></section>
		<section class="account-section"><h2>Email</h2><label class="switch"><input type="checkbox" id="notify-comments"><span>Email me when someone comments on my videos</span></label><p class="login-status" id="notify-status" role="status"></p></section>
		<section class="account-section"><h2>Connected computers</h2><ul id="account-devices" class="device-list"></ul><p class="subtle">To connect another computer, press Share in VidCapture on it.</p></section>
		<section class="account-section"><h2>Password</h2><form id="password-form" class="auth-form inline" novalidate><label for="current-password">Current password</label><input id="current-password" type="password" autocomplete="current-password"><label for="new-password">New password</label><input id="new-password" type="password" autocomplete="new-password" minlength="10" required><button class="quiet" type="submit">Change password</button><p class="login-status" role="status"></p></form></section>
		<section class="account-section"><h2>Delete account</h2><p>Removes every video you have shared and their links. Recordings on your computer are not affected.</p><form id="delete-form" class="auth-form inline" novalidate><label for="delete-password">Password</label><input id="delete-password" type="password" autocomplete="current-password"><button class="quiet danger" type="submit">Delete my account</button><p class="login-status" role="status"></p></form></section>
		<p id="admin-link" hidden><a class="text-link" href="/admin">Moderation</a></p></main>` },
	'/admin': { title: 'Moderation', nav: 'app', signedIn: true, admin: true, body: `<main class="library admin-page"><div class="page-heading"><div><h1>Moderation</h1></div></div><section class="account-section"><h2>Open reports</h2><div id="admin-reports"><p class="subtle">Loading…</p></div></section><section class="account-section"><h2>Accounts</h2><div class="table-wrap"><table id="admin-accounts"><thead><tr><th>Email</th><th>Joined</th><th>Videos</th><th>Storage</th><th></th></tr></thead><tbody></tbody></table></div></section></main>` },
	'/terms': { title: 'Terms', nav: 'viewer', body: `<main class="legal"><h1>Terms of use</h1><p class="subtle">Last updated November 7, 2026</p>
		<p>VidCapture lets you record on your computer and share videos you choose to upload to vidcapture.stream. By creating an account you agree to these terms.</p>
		<h2>Your account</h2><p>You need a valid email address. Keep your password private; you are responsible for activity under your account. Free accounts include 5 GB of storage, which may change with notice.</p>
		<h2>Your videos</h2><p>You keep ownership of what you upload. You give us permission to store your videos and show them to the people you share them with, only to run the service. Upload only content you have the right to share.</p>
		<h2>Not allowed</h2><p>Illegal content, content that exploits or endangers children, harassment, sharing someone's private information, malware, spam, or content that infringes someone else's rights. We may remove videos or disable accounts that break these rules, and may report illegal content to the authorities.</p>
		<h2>Comments</h2><p>Comments are visible to everyone who has a video's link. The same rules apply to comments as to videos. Video owners can delete any comment on their videos and turn comments off.</p>
		<h2>Reports</h2><p>Anyone can report a video with the Report video link under it. Copyright holders can report infringement the same way.</p>
		<h2>The service</h2><p>VidCapture is an early release provided as is, without warranties. Keep your own copies; recordings stay on your computer unless you delete them. We may change or end the service, and you can delete your account at any time from the Account page.</p></main>` },
	'/privacy': { title: 'Privacy', nav: 'viewer', body: `<main class="legal"><h1>Privacy policy</h1><p class="subtle">Last updated November 7, 2026</p>
		<h2>What we store</h2><p>Your email address, a salted hash of your password, the videos and preview images you upload, their titles and play counts, the names of the computers you connect, and comments with the name each commenter enters. Recordings you do not share never leave your computer.</p>
		<h2>Emails</h2><p>We email you only about your account: confirming your address, password resets, sign-in links you request, and new comments on your videos (at most one email per video every 15 minutes, and you can turn these off on your Account page). No newsletters or marketing.</p>
		<h2>Viewers</h2><p>To count plays without counting the same person twice, we store a one-way fingerprint of the video and the viewer's network address for six hours. We do not use advertising or third-party analytics.</p>
		<h2>Where it lives</h2><p>Data is stored with Cloudflare (R2 storage, D1 database, Workers).</p>
		<h2>Your choices</h2><p>Make any video private or remove it from your library. Delete your account from the Account page to remove all of your uploaded videos and your email address.</p></main>` },
};
