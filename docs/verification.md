# Release verification

## Alpha.9 update-check status

Alpha.9 fixes the Updates dialog when an automatic check is already running. It reports that the check is in progress instead of saying the app is up to date before the response arrives. The main-process lifecycle suite covers this overlap. The updater and installation behavior are otherwise unchanged from alpha.8.

## Alpha.8 app updates

Alpha.8 adds automatic GitHub release checks, an Updates control, verified source downloads, separate native-helper builds, and an explicit restart to activate the new app. Existing alpha.7 and earlier installations need one manual upgrade.

Verification for the updater:

- Release selection tests cover numeric prereleases, stable channels, no downgrades, draft and incomplete releases, foreign URLs, rate limits, and size limits.
- Isolated installation tests verify SHA-256 checks, safe extraction, build failures, launcher changes, old-source preservation, settings preservation, and development-checkout protection.
- Main-process lifecycle tests run the real app wiring with isolated adapters. They cover active takes, countdowns, processing, extension mutations, installation and restart confirmation races, controls during preparation, edit flushing, and relaunch arguments. They do not operate hardware.
- A live public alpha.7 archive was downloaded through the updater, verified against its GitHub digest, and both native helpers were built with the real toolchain. Activation changed only an isolated test home's launcher. The workstation's installed app was not restarted.
- Headless Chromium checks cover the update button at 820 and 390 pixels, including available, preparing, and ready states, keyboard activation, and overflow. Screenshots were visually inspected.

Limits: no automatic upgrade can reach a copy that predates the updater. The unpacked Chrome extension still needs a separate update. No new physical recording or broad hardware compatibility test was performed for this change. The updater trusts the project's GitHub release and its HTTPS-served asset digest; it does not use a separate offline signing key.


Alpha.7 adds a compact Chrome extension panel for the desktop recorder's settings, a microphone level indicator on the floating recording controls, and safer handling when the selected microphone disappears. It also changes camera-preview shutdown for the transport path without background effects and places the recording controls before they appear. The extension is packaged as a versioned ZIP, with an installation guide. [Extension settings](../extension/SETTINGS.md) lists the controls and their limits.

These changes were reviewed by reviewers separate from their authors on November 7 and 8, 2026, on the same single Omarchy workstation:

- 297 Node tests passed in the alpha.7 snapshot by itself, run from a fresh extraction of the release archive, including the extension settings tests, the microphone level, mute and source-loss tests, the camera lifecycle tests and the recording-controls placement tests. The snapshot passed the privacy audit.
- **Extension panel.** The panel keeps Start and the source choice up front and adds Camera & background, Audio, and Recording views covering all 18 recorder settings. The desktop app's extension bridge accepts the settings commands, refuses them during a take, countdown or processing, and runs native file and folder choosers itself without accepting browser paths. Tests drive the real recorder, camera settings and extension bridge with fixture devices.
- **Microphone level and mute.** With an isolated audio server and a synthetic tone source, the level indicator moved while the selected microphone carried sound. It showed silence after the microphone was muted or its volume was set to zero, and the saved recording matched: tone, then silence, with no fallback to another source.
- **Microphone loss.** With the same isolated setup, removing the selected microphone stopped the take, saved the part recorded before the loss as a playable file, and showed a persistent warning, instead of switching to another microphone.
- **Camera preview shutdown.** On one workstation, the old transport-preview shutdown path reproduced a video-player crash on cycle 12 of a synthetic test. With the change, 60 intended closes completed without a crash. The change applies only to previews fed by the camera transport without background effects. It avoids that teardown path; it does not establish the precise crash cause, repair a graphics driver, or certify physical-camera behavior, background blur, or longer use.
- **Recording-controls placement.** A compositor rule now gives the floating controls their initial position before they appear. In one controlled native run, all 272 tone frames and 392 narration frames passed the unchanged margin check without the earlier controls intrusion. Sampled frames showed only the owned test scene. This is captured-video evidence, not a continuous window-mapping trace or a guarantee for every monitor setup. The first narration frame still showed minor glyph irregularities; pristine raster rendering was not established.
- **Editing and sharing, end to end.** In one native run on the workstation, with a short synthetic recording and a disposable account device, the desktop app deleted words from the transcript, undid and reapplied the cut, saved, reopened the project with the cut kept, exported, and shared. The downloaded shared file matched the exported file byte for byte. In Chromium, the shared page showed captions and a transcript that matched the cut, kept a seek, played through the cut and reached the end. The run then deleted the share and its device and signed out. Earlier attempts stopped before completing, mostly on problems in the test harness; one exposed the recording-controls placement issue fixed above. This single run does not establish reliability across many runs. Browser playback was muted and nobody listened to it.

Not yet verified for this release:

- The first scheduled weekly summary, due November 9, 2026 at 13:00 UTC, has not yet been observed. Local tests and manual triggers do not establish delivery of that scheduled message.

The audio checks used synthetic sources on an isolated audio server. Nobody listened to judge audio quality, and the checks do not establish behavior across microphones or audio hardware. Physical camera rendering, blur quality and native chooser placement were not part of these checks. In the audio test runs, the test harness's automatic desktop restore declined and was completed by a separate guarded step; this is a limit of the test harness, not a product behavior.

## Alpha.6 checks

Alpha.6 changes only the project's GitHub test workflow. The extension's native host starts with `#!/usr/bin/node`, the path of the `nodejs` package the install requires on Arch. The test runner kept Node elsewhere, so alpha.5's native host test failed there with ENOENT; the workflow now places the selected Node at /usr/bin/node and checks its version before the tests run. The app, extension and website are unchanged from alpha.5, so the alpha.5 checks below still describe them.

- 182 Node tests passed in the published snapshot by itself, and the snapshot passed the privacy audit.

## Alpha.5 checks

Alpha.5 adds Turnstile on sign-up and account email, report and weekly-summary emails for the site owner, a reworked library and watch page for owners, desktop fixes (window class rules, copy-after-share, rename errors, Recordings actions, switching the microphone from the top-bar panel while cleanup is on), microphone cleanup health checks, and a corrected privacy description. Each change was checked by a reviewer separate from its author on November 7, 2026, on the same single Omarchy workstation:

- 182 Node tests passed in the published snapshot by itself. This is the first snapshot built from an explicit file allowlist: only reviewed files listed by exact path are published, and a new file is left out until someone reviews it. It also passed the privacy audit.
- A native rehearsal on Hyprland: VidCapture's own windows matched their window rules and stayed out of the source list, and the panel, countdown and recording controls appeared where expected. The take it saved, 63.5 seconds long, probed as H.264 at 1920 x 1024 with two stereo AAC tracks (cleaned and backup microphone), decoded fully, and both audio tracks carried signal. This does not measure noise-removal quality, long recordings, or camera performance.
- Microphone cleanup health: the app now checks that its own cleanup chain owns the expected PipeWire nodes and links, not just that the process runs. In a native check with a task-owned virtual microphone, the graph matched, the level meter moved, and a saved take decoded with speech on both tracks while the noise-only stretch was effectively silent on the cleaned track (about -45 dBFS on the backup). When the virtual microphone disappeared, the app retried twice, stopped within 14 seconds instead of looping, and showed the error in the main window and the panel; Try again recovered once the device returned. Start refused to record while the selected microphone was missing. Quitting stopped the cleanup chain and level meter with nothing restarting afterward. This was a single virtual-device setup; it does not establish reliability across microphones or audio hardware, and nobody listened to judge audio quality.
- After a share, "Link copied" appears only once the clipboard holds the link; a slow or failed copy falls back or says so. A failed rename keeps what you typed, with retry and cancel.
- The website's account, sign-in, comment, sharing and library suites passed against a local Worker with Cloudflare's Turnstile test keys; sign-up and account email refuse requests without a valid check.
- The privacy text on the website and in this README was compared with the code that sends transcript text for punctuation and titles.

Hardware checks were not repeated beyond the rehearsal above; broader hardware compatibility is still not established.

## Alpha.4 checks

Alpha.4 adds sharing, shortcut and recording changes to alpha.3. Alpha.4 checks:

- 143 Node tests passed in the published snapshot by itself, including the new caption tests.
- The snapshot was built the same way as alpha.3: an exclusion list removed known private files and the privacy audit passed.
- On vidcapture.stream, account emails sent through Amazon SES reached a Gmail inbox with DKIM, SPF and DMARC passing.

The hardware checks below were done for alpha.3 on the same day and were not repeated.


## Alpha.3 checks

Checked on November 7, 2026, on one Omarchy workstation: Hyprland 0.56.2, Electron 43.8.3, GPU Screen Recorder 6.1.4, FFmpeg 9.0.2, Intel graphics with an NVIDIA Quadro T2000 (driver 615.78.08). No other hardware compatibility is claimed.

- 117 Node tests passed in the published snapshot by itself, including real FFmpeg cut and export, transcript editing, camera settings, the microphone cleanup chain configuration, background effect arguments, share reuse, and sharing-origin checks. No test uploads anything.
- The snapshot was built by copying the tracked source and removing files on an exclusion list, then audited for private paths, credentials, production resource IDs, personal camera profiles, media, and model files before publishing. An exclusion list does not catch a new private file it doesn't name; alpha.5 replaced it with an explicit allowlist.
- `scripts/setup-transcription.sh` installed into an empty folder in about 80 seconds (860 MB). On 90 seconds of real speech it transcribed in 12 seconds on the CPU and agreed with the reference Parakeet transcriber on 314 of 316 words.
- `scripts/setup-camera-effects.sh` installed the effect runtime (2.6 GB). Background blur and image replacement ran at 30 fps on a 4K Razer Kiyo Pro Ultra and on a built-in laptop webcam, with about 17 ms of added latency, while GPU Screen Recorder held 30 fps. Blur strength and image changes applied live.
- Microphone cleanup: noise removal with the gentle and strong voice gate kept 321 to 322 of 328 words recognizable on real speech. A test recording kept the cleaned track and the raw backup track.
- Camera controls changed live in the preview and were restored afterwards.
- The Worker type-checks against both the production configuration and `cloud/wrangler.example.jsonc`.

Not tested: a fresh Omarchy installation, another person's Cloudflare account, AMD or Intel-only machines for background effects, broad camera and GPU combinations, and the Chrome extension in Google Chrome.
