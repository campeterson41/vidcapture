# v0.1.0-alpha.3 verification

Checked on November 7, 2026, on one Omarchy workstation: Hyprland 0.56.2, Electron 43.8.3, GPU Screen Recorder 6.1.4, FFmpeg 9.0.2, Intel graphics with an NVIDIA Quadro T2000 (driver 615.78.08). No other hardware compatibility is claimed.

- 117 Node tests passed in the published snapshot by itself, including real FFmpeg cut and export, transcript editing, camera settings, the microphone cleanup chain configuration, background effect arguments, share reuse, and sharing-origin checks. No test uploads anything.
- The snapshot was built from an allowlist and audited for private paths, credentials, production resource IDs, personal camera profiles, media, and model files before publishing.
- `scripts/setup-transcription.sh` installed into an empty folder in about 80 seconds (860 MB). On 90 seconds of real speech it transcribed in 12 seconds on the CPU and agreed with the reference Parakeet transcriber on 314 of 316 words.
- `scripts/setup-camera-effects.sh` installed the effect runtime (2.6 GB). Background blur and image replacement ran at 30 fps on a 4K Razer Kiyo Pro Ultra and on a built-in laptop webcam, with about 17 ms of added latency, while GPU Screen Recorder held 30 fps. Blur strength and image changes applied live.
- Microphone cleanup: noise removal with the gentle and strong voice gate kept 321 to 322 of 328 words recognizable on real speech. A test recording kept the cleaned track and the raw backup track.
- Camera controls changed live in the preview and were restored afterwards.
- The Worker type-checks against both the production configuration and `cloud/wrangler.example.jsonc`.

Not tested: a fresh Omarchy installation, another person's Cloudflare account, AMD or Intel-only machines for background effects, broad camera and GPU combinations, and the Chrome extension in Google Chrome.
