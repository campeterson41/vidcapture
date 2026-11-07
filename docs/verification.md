# v0.1.0-alpha.2 verification

Release preparation on November 7, 2026:

- GPU Screen Recorder 6.1.4 source built from the pinned revision with the included window-follow patch.
- Camera transport built with the installed FFmpeg development libraries.
- 43 Node tests passed, including self-hosted HTTPS origin/key binding and rejection of unsafe origin changes.
- Additional installation, pairing, and website results will be appended before publication.

Environment: Omarchy workstation, Hyprland 0.56.2, Electron 43.8.3, GPU Screen Recorder 6.1.4, FFmpeg 9.0.2. An isolated home on this same machine is not a fresh OS installation. No other hardware compatibility is claimed.

Additional checks completed:

- Installation and uninstallation passed with an isolated destination on the same workstation. Unrelated launcher files were preserved.
- Local D1 pairing created an owner-only key file without printing it, authenticated to the local library API, and refused to overwrite an existing connection.
- Website TypeScript check passed. Homepage install links and early-release/sharing limitations were inspected through the local browser.

Not tested: a fresh Omarchy installation, another person's Cloudflare account, broad camera/GPU combinations, or a new end-to-end recording session for this release.
