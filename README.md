# VidCapture

A Loom-style recording workflow for Omarchy. Record your screen, cut the take locally, and share the finished video.

VidCapture records a window, area, or display with a microphone and an optional camera bubble. Trim the ends, cut sections, and export a separate MP4. Recording and editing work without an account. Optional sharing uses a Cloudflare Worker you deploy in your own account.

**Early source release, v0.1.0-alpha.2.** Tested on one Omarchy workstation with Hyprland 0.56.2, Electron 43, GPU Screen Recorder 6.1.4, and FFmpeg 9. Broader hardware compatibility is not yet established. Hosted signup at vidcapture.stream is not open.

[Project website](https://vidcapture.stream) · [Releases](https://github.com/campeterson41/vidcapture/releases) · [Report a bug](https://github.com/campeterson41/vidcapture/issues)

## What it does

- Record a display, a fixed area, or a visible window that follows moves and resizes on the same display.
- Add microphone and system audio, plus an optional circular camera overlay.
- Pause and resume from floating controls or the tray.
- Trim and cut without overwriting the original recording.
- Export H.264/AAC MP4, with Intel hardware export when available and software fallback.
- Optionally publish to your own sharing server with resumable uploads, unlisted watch links, and linked animated video cards.

## Install

This release targets current Omarchy with **Hyprland 0.56 and its Lua window-rule API**. Older Hyprland releases are unsupported. It uses system Electron 43 rather than downloading an Electron runtime. The commands below build both helpers from source; do not skip those steps.

Install prerequisites from your configured Arch/Omarchy repositories:

```sh
sudo pacman -S --needed git nodejs python electron43 gpu-screen-recorder ffmpeg mpv v4l-utils libpulse gcc pkgconf uv libx11 libxcomposite libxrandr libxfixes libxdamage libva libdrm wayland dbus libpipewire mesa
```

Then clone and install:

```sh
git clone https://github.com/campeterson41/vidcapture.git
cd vidcapture
git checkout v0.1.0-alpha.2
./engine/build.sh
./engine/build-camera.sh
./install.sh
```

Open **VidCapture** in your application launcher, or run `capture`. Keep the source directory in place: the launcher points to it. The build downloads pinned GPU Screen Recorder source, Vulkan headers, Meson, and Ninja. It installs private helpers in this checkout and leaves the system recorder unchanged.

If a prerequisite is missing, installation stops with its name. GPU capture still depends on your GPU, drivers, permissions, and the working system GPU Screen Recorder/KMS helper. The installer does not change system capabilities or drivers.

## First recording

Choose your source, microphone, and optional camera. Start recording, then use **Stop and save**. Open the recording in Edit, select a range, cut or trim, and choose **Save edited copy**.

Files save under `~/Videos/Capture`; settings and metadata live under `~/.local/state/capture`. Capture writes MKV while recording and remuxes to MP4 on stop. If conversion fails, it keeps the MKV.

`capture --pick` opens source selection. Add a shortcut in your own Hyprland configuration if desired. This installer does not change your bindings.

## Optional sharing

[Deploy and connect your own sharing server](docs/sharing.md). Local recording and editing do not require it. You need your own Cloudflare account and may incur its usage charges. This release does not grant access to Cameron's hosted service or include his device keys.

Only explicitly shared videos upload. Anyone holding an unlisted link can view and download that video. It is not password-protected. Deleting a shared video revokes its link but cannot recall downloaded copies.

## Limitations

- Window mode follows a screen crop. Other windows covering it appear in the video. Moving it to another display, hiding it, or closing it stops and saves the take.
- Full-display recording on a single display includes the collapsed recording control. Notifications can also appear in captures.
- Camera testing concentrated on a Razer Kiyo Pro Ultra. Other cameras and GPU combinations need testing.
- Personalized audio enhancement adapters and voice profiles are not included in this release. The enhancement action is disabled when the required local runtime is unavailable. Ordinary recording and editing remain available.
- No transcripts, captions, comments, password-protected links, or team workspaces. Sharing delivers the exported MP4, without adaptive streaming renditions.
- No macOS or Windows build, AUR package, or compatibility guarantee for every Wayland desktop.

## Uninstall

Quit VidCapture, then run `./uninstall.sh` from the checkout. It removes only owned launcher entries and preserves recordings, settings, sharing keys, and source. Remove the source directory yourself only after saving any work you want to keep.

## Development

```sh
npm test
```

Tests require FFmpeg and FFprobe on PATH. The Node tests cover recording arguments, camera lifecycle and IPC, geometry, edits, upload behavior, and sharing-origin validation. They do not establish clean-machine or broad GPU compatibility. See [verification](docs/verification.md) for what was actually checked for this release.

Use Issues for reproducible bugs. Include your Omarchy/Hyprland versions, GPU and driver, recording source, and the exact error. Never include publishing.json, device keys, sign-in links, private recordings, or client information. Report vulnerabilities through GitHub's private security advisory flow when available.

## License and credits

Original VidCapture application code is MIT licensed. The separately built GPU Screen Recorder helper and patch remain GPL-3.0-only; see [engine/README.md](engine/README.md), its pinned source and build script, and the full license in licenses/. Third-party components retain their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md). VidCapture is an independent project, unaffiliated with Omarchy or Loom.
