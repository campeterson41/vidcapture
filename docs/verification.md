# v0.1.0-alpha.6 verification

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
