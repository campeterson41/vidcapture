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
		<div class="hero-actions"><a class="button" href="https://github.com/campeterson41/vidcapture#install">Install on Omarchy</a>${signedIn ? '<a class="button secondary" href="/library">My library</a>' : '<a class="button secondary" href="/login#signup">Create a free account</a>'}</div>
		<p class="hero-note">Open-source early release for Omarchy and Hyprland 0.56. Recording and editing work locally. Sharing uses a free vidcapture.stream account with 5 GB of storage, or your own Cloudflare deployment.</p>
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
	</div>

	<article class="feature">
		<div class="feature-copy">
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
			<h3>Cut the stumbles before anyone sees them</h3>
			<p>Edit on a waveform timeline, where pauses and false starts are easy to spot. Select a range and cut it, or trim to just the part you need. Every change can be undone.</p>
			<ul>
				<li>Nondestructive: your original recording is never overwritten</li>
				<li>Playback skips removed sections, so you hear the final cut as you edit</li>
				<li>Audio enhancement requires a separately configured runtime and is not bundled in the public source release</li>
			</ul>
		</div>
		<div class="feature-visual">${editShot()}</div>
	</article>

	<article class="feature">
		<div class="feature-copy">
			<h3>Share with one click</h3>
			<p>Press Share and VidCapture uploads your edited cut, never the raw take, then hands you a link. Anyone can watch it in a browser. They do not need an account.</p>
			<ul>
				<li>Uploads run in parallel parts and resume where they stopped after a dropped connection</li>
				<li>Viewers can seek instantly, change speed up to 3×, use picture in picture, and play full screen</li>
				<li>Viewers can comment at an exact moment, and you can turn comments off for any video</li>
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
			<h3>Public or private, per video</h3>
			<p>Only you can see your library. Each video gets a link built from 192 bits of randomness, which cannot be guessed or found by browsing. Public videos play for anyone you send the link to. Private videos only play for you while you are signed in, and you can switch either way at any time.</p>
		</div>
		<div>
			<h3>Your account and your computer</h3>
			<p>Create a free account with your email and a password. The first time you press Share, VidCapture opens your browser so you can log in and connect the app. The app then holds a private device key, and the website only ever stores a fingerprint of it.</p>
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
		<p>Most people choose between a hosted recorder that lives in the browser, or a desktop recorder that leaves sharing to them.</p>
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
			<tr><th scope="row">Comments at a moment in the video</th><td class="us">${check}<span>No viewer account needed</span></td><td>${check}<span>Usually requires sign-in</span></td><td>${dash}<span>Not included</span></td></tr>
			<tr><th scope="row">No viewer tracking scripts</th><td class="us">${check}<span>Play count only</span></td><td>${dash}<span>Viewer analytics are common</span></td><td>${dash}<span>Depends on the host</span></td></tr>
		</tbody>
	</table>
	</div>
	<div class="not-yet">
		<h3>What VidCapture does not do yet</h3>
		<p>There are no Mac, Windows, or mobile apps. Share pages have no captions or transcripts, and there are no password-protected links or team workspaces. Videos are delivered as the single file you exported, not in multiple streaming qualities, so viewers on slow connections may wait longer for very high resolution video.</p>
	</div>
</section>

<section class="faq" id="faq">
	<div class="section-head"><h2>Questions</h2></div>
	<div class="faq-list">
		<details><summary>Do the people I send a link to need an account?</summary><p>No. Anyone with the link to a public video can watch in their browser. Private videos only play for you. Accounts are only for managing your own library.</p></details>
		<details><summary>Does VidCapture upload my recordings automatically?</summary><p>Never. Recordings stay on your computer. A video only leaves when you press Share, and only the edited version you chose is sent.</p></details>
		<details><summary>Can someone find my videos without the link?</summary><p>No. Videos are not listed or searchable, and their links are random enough that they cannot be guessed. Anyone who has the link can watch and download the video, so share it with the people you trust.</p></details>
		<details><summary>What happens when I remove a video?</summary><p>Its link stops working immediately and the stored file is deleted. Your original recording on your computer is not affected. Copies that viewers already downloaded cannot be recalled.</p></details>
		<details><summary>How long can a video be?</summary><p>There is no limit on recording length. Each shared video can be up to 12 hours long and up to 20 GB.</p></details>
		<details><summary>Can viewers leave comments?</summary><p>Yes. Anyone who can watch a video can comment, without an account, and pin a comment to the moment they were watching. Comments are visible to everyone with the link. You can delete any comment on your videos or turn comments off for a video.</p></details>
		<details><summary>Which browsers can watch?</summary><p>Videos are standard H.264 MP4 files, which modern desktop and mobile browsers can play. The player supports speed control, keyboard shortcuts, picture in picture, and full screen.</p></details>
		<details><summary>What do I need to run VidCapture?</summary><p>A Linux desktop running the Hyprland compositor, such as Omarchy. Other platforms are not supported yet.</p></details>
		<details><summary>How do I sign in to my library?</summary><p><a href="/login">Log in</a> with your email and password, or click Video library in VidCapture to open it already signed in. Each account includes 5 GB of free storage.</p></details>
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
		<h2>Emails</h2><p>We email you only about your account: confirming your address, password resets, and sign-in links you request. No newsletters or marketing.</p>
		<h2>Viewers</h2><p>To count plays without counting the same person twice, we store a one-way fingerprint of the video and the viewer's network address for six hours. We do not use advertising or third-party analytics.</p>
		<h2>Where it lives</h2><p>Data is stored with Cloudflare (R2 storage, D1 database, Workers).</p>
		<h2>Your choices</h2><p>Make any video private or remove it from your library. Delete your account from the Account page to remove all of your uploaded videos and your email address.</p></main>` },
};
