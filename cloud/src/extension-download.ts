// Enable only after the exact versioned ZIP and checksum are published and verified.
export const extensionRelease = {
 version: '0.3.0', tag: 'v0.1.0-alpha.7', filename: 'vidcapture-extension-v0.3.0.zip', available: true,
};
const repo='https://github.com/campeterson41/vidcapture';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function extensionInstallPrompt(release=extensionRelease){
 const download=`${repo}/releases/download/${release.tag}/${release.filename}`;
 return `Install VidCapture Chrome extension ${release.version} on this computer using the official release ${repo}/releases/tag/${release.tag} and its extension/INSTALL.md at ${repo}/blob/${release.tag}/extension/INSTALL.md.

Check that this is supported Omarchy/Linux, that Chrome or Chromium is available, and that system Node.js at /usr/bin/node and the VidCapture desktop launcher at ~/.local/bin/capture are installed. Recording requires the local desktop app, not just the extension. If the app needs installation or updating, follow the pinned release README and report any unmet prerequisites.

Download ${download} and its .sha256 file from that release. Verify the published checksum, inspect PACKAGE-CONTENTS.json, and extract into a lasting folder such as ~/.local/share/vidcapture-extension. Inspect and preserve an existing installation or local edits before replacing files. Preserve the manifest key and extension ID dagpaflngbhbgpeichcnhalplkdmkfie.

From the extracted folder, run bash native/install.sh --browser chromium (or --browser chrome for Google Chrome). Use --user-data-dir with an absolute path if this browser uses a custom data folder. Keep existing flags, other extensions, profiles, tabs, recordings, and unsaved work intact. Do not use broad sudo, remote shell piping, permission bypasses, or hidden browser/app restarts. Honor any required prerequisite approvals.

Use supported browser controls to open chrome://extensions, enable Developer mode, load the folder containing manifest.json, and pin VidCapture. Preserve required approvals and user-presence checks. If a managed policy or unavailable browser control prevents that step, report the exact restriction rather than bypassing it or claiming success.

Verify the loaded settings footer says Extension ${release.version} and the popup says Connected to desktop app. Open Camera & background and confirm its settings load without connection errors. Reopen the popup and confirm the connection again without starting a recording or changing my settings. Native-host registration alone is not proof of a working connection. Summarize what was installed, its lasting location, and any actual remaining limitation.`;
}
export function extensionDownloadSection(release=extensionRelease){
 const download=`${repo}/releases/download/${release.tag}/${release.filename}`;
 if(!release.available)return `<section class="extension-install" id="chrome-extension"><div class="section-head"><h2>VidCapture in your browser</h2><p>Recording controls for Chrome and Chromium, backed by the local VidCapture app on Omarchy.</p></div><p class="extension-release-note">The versioned extension download is being prepared. The desktop app is available from <a href="${repo}#install">GitHub</a>.</p></section>`;
 const command=`mkdir -p "$HOME/.local/share/vidcapture-extension"\nunzip "$HOME/Downloads/${release.filename}" -d "$HOME/.local/share/vidcapture-extension"\nbash "$HOME/.local/share/vidcapture-extension/native/install.sh" --browser chromium`;
 return `<section class="extension-install" id="chrome-extension">
 <div class="section-head"><h2>VidCapture in your browser</h2><p>Start a take, choose your camera and microphone, or adjust background blur from the toolbar. The installed desktop app does the recording, so changing tabs leaves the camera session alone.</p></div>
 <div class="extension-intro"><div><p class="extension-requirement">Requires VidCapture desktop on Omarchy/Linux. For Chrome or Chromium.</p><p>This is an unpacked extension with a short setup, rather than a Chrome Web Store install.</p></div><div class="extension-download-actions"><a class="button" href="${download}">Download Chrome extension <span>v${release.version}</span></a><a class="extension-checksum" href="${download}.sha256">SHA256 checksum</a></div></div>
 <div class="extension-setup-grid">
  <div class="extension-manual"><h3>Set it up once</h3><ol><li>Install or update the <a href="#install">desktop app</a>, then download and extract the ZIP to a lasting folder.</li><li>Register its local connection with <code>bash native/install.sh --browser chromium</code> from the extracted folder. Use <code>--browser chrome</code> for Google Chrome.</li><li>Enter <code>chrome://extensions</code> in the address bar. Turn on Developer mode, click Load unpacked, and choose the folder containing <code>manifest.json</code>.</li><li>Pin VidCapture from the puzzle menu. Open it and check <strong>Connected to desktop app</strong>, then open Camera &amp; background to confirm its settings load.</li></ol><p><a href="${repo}/blob/${release.tag}/extension/INSTALL.md">Full install and update guide ↗</a></p></div>
  <div class="extension-agent"><h3>Let Claude or Codex help</h3><p>Give your coding agent the setup prompt. It checks prerequisites, preserves your browser setup, and verifies the connection.</p><button class="button secondary" type="button" data-extension-copy="extension-agent-prompt">Copy installation prompt</button><p class="extension-copy-status" id="extension-copy-status" role="status" aria-live="polite"></p><details class="extension-prompt"><summary>Read or select the prompt</summary><label class="sr-only" for="extension-agent-prompt">Claude or Codex installation prompt</label><textarea id="extension-agent-prompt" readonly rows="12" spellcheck="false">${escape(extensionInstallPrompt(release))}</textarea></details></div>
 </div>
 <details class="extension-terminal"><summary>Prefer the terminal?</summary><p>After downloading and verifying the ZIP, these are the fresh-install steps. Adjust the ZIP path if your browser saves elsewhere.</p><pre class="code"><code>${escape(command)}</code></pre><p>Keep the extracted folder in place. These commands register the native host; finish with Load unpacked in the browser. No launch flags are edited and nothing is restarted.</p><details><summary>Already have the desktop source checkout?</summary><p>Use its extension folder instead of a second ZIP installation. From an updated ${release.tag} or newer checkout:</p><pre class="code"><code>bash "./extension/native/install.sh" --browser chromium</code></pre><p>Then load that checkout’s <code>extension/</code> folder unpacked.</p></details></details>
 <script src="/extension-install.js" defer></script>
</section>`;
}
