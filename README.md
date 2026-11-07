# VidCapture

A Loom-style recorder for Omarchy. Record your screen with a camera bubble, edit the take locally, and share a link.

VidCapture records a window, area, or display with your microphone, system audio, and an optional circular camera. Cut and trim with a word-level transcript, remove filler words, and save a new MP4. Recording and editing work without an account and stay on your computer. Sharing is optional: use a free vidcapture.stream account, or deploy the sharing server in your own Cloudflare account.

**Early source release, v0.1.0-alpha.5.** Tested on one Omarchy workstation with Hyprland 0.56.2, Electron 43, GPU Screen Recorder 6.1.4, FFmpeg 9, and an NVIDIA Quadro T2000 alongside Intel graphics. Broader hardware compatibility is not yet established.

[Project website](https://vidcapture.stream) · [Releases](https://github.com/campeterson41/vidcapture/releases) · [Report a bug](https://github.com/campeterson41/vidcapture/issues)

## What it does

- **Record** a display, a fixed area, or a window that the recording follows as it moves and resizes on the same display. A record panel drops down from the top bar, with live thumbnails of each screen and window, a mic level meter, and a 3, 2, 1 countdown.
- **Camera bubble** at up to 4K, with background blur or a background image, every camera control the camera offers, and optional lighting.
- **Clean audio while you record:** noise removal, a voice gate, and a rumble filter, with the untouched microphone kept as a backup track.
- **Edit without re-recording.** Trim, cut, and undo. Read the transcript, click a word to jump there, select words to cut them, and remove "um" and "uh" in one step. Every save is a new version; the original is never overwritten.
- **Library** of every take and its versions, with titles written from what you said.
- **Share** an unlisted link with resumable uploads, a link preview for Slack and LinkedIn, an animated card for email, and timestamped comments. VidCapture remembers what is already uploaded and reuses the link.
- **Chrome extension** that shows VidCapture links as animated previews in Gmail and starts a recording from the toolbar.

## Install

This release targets current Omarchy with **Hyprland 0.56 and its Lua window-rule API**. Older Hyprland releases are unsupported. It uses system Electron 43 rather than downloading its own.

Install prerequisites from your Arch/Omarchy repositories:

```sh
sudo pacman -S --needed git nodejs python electron43 gpu-screen-recorder ffmpeg mpv v4l-utils libpulse gcc pkgconf uv libx11 libxcomposite libxrandr libxfixes libxdamage libva libdrm wayland dbus libpipewire mesa
```

Then clone, build the two helpers, and install:

```sh
git clone https://github.com/campeterson41/vidcapture.git
cd vidcapture
git checkout v0.1.0-alpha.5
./engine/build.sh
./engine/build-camera.sh
./install.sh
```

Open **VidCapture** from your application launcher, or run `capture`. Keep the source folder in place: the launcher points to it. The build downloads pinned GPU Screen Recorder source, Vulkan headers, Meson, and Ninja, and installs private helpers inside this checkout. The system recorder is unchanged.

If a prerequisite is missing, installation stops and names it. GPU capture still depends on your GPU, drivers, permissions, and a working system GPU Screen Recorder. The installer does not change system capabilities, drivers, or your Hyprland bindings.

### Optional features

Each of these installs separately and only into your home folder. VidCapture works without them; until one is installed, its setting says what to run. The voice gate works together with noise removal.

| Feature | Install | Needs |
| --- | --- | --- |
| Transcripts, filler-word removal, automatic titles | `./scripts/setup-transcription.sh` | About 1 GB. Runs on the CPU. |
| Background blur and background images | `./scripts/setup-camera-effects.sh` | An NVIDIA GPU with a current driver. About 2.6 GB. |
| Noise removal and voice gate | `sudo pacman -S noise-suppression-for-voice` | PipeWire. |
| Chrome extension | `./extension/native/install.sh`, then load `extension/` unpacked | Chromium or Google Chrome. |

Restart VidCapture after installing one.

## Recording

Click the VidCapture icon in the top bar, or open VidCapture from the launcher. Choose **Full screen**, **Window**, or **Area**, pick a camera and microphone, and press **Start recording**. While recording, the top bar shows the elapsed time; click it, or use the small floating controls, to pause or stop. `capture --panel` opens the record panel from a shortcut of your own.

Files save under `~/Videos/Capture`. VidCapture writes MKV while recording, so a crash cannot lose the take, and converts it to MP4 when you stop. If conversion fails, the MKV is kept.

### Studio settings

The Record page holds every recording setting.

- **Microphone.** Mic level, plus live cleanup that runs while you record: **Noise removal** (RNNoise), a **Voice gate** (Gentle or Strong) that silences the gaps between words, and a **Rumble filter** for hum below 80 Hz. **Backup track** keeps the untouched microphone as an extra audio track, so cleanup never costs you the original.
- **Camera.** Every standard UVC control the camera reports: exposure, gain, backlight, white balance, brightness, contrast, saturation, sharpness, focus, zoom, pan, tilt, and anti-flicker. Changes show live in the preview and are saved per physical camera, then applied each time it opens, because cameras forget them when unplugged. Nothing is written to camera firmware.
- **Background.** **Blur** (Light, Medium, or Strong) or **Image**. Add your own JPEG, PNG, or WebP. A separate process on the NVIDIA GPU finds you with Robust Video Matting and blurs or replaces everything else at 30 fps. If an effect is chosen but cannot start, the camera stays off rather than showing what you meant to hide.
- **Screen.** Frame rate (30 or 60), quality, and resolution.

### Camera profiles

A camera profile is optional tuning for one camera model, written as JSON and matched by USB vendor and product ID: vendor commands through the camera's UVC extension unit, GPU lens correction, and Intel GPU decoding for a low-latency 4K preview. Cameras without a profile work normally. Put profiles in `~/.config/vidcapture/camera-profiles/`; the format is in [camera-profiles/README.md](camera-profiles/README.md).

## Editing and transcripts

Open a recording to edit it. Select a range on the timeline, then cut or trim. When transcription is installed, the transcript appears beside the video with each word timed: click a word to jump to it, select words to cut them, and use **Remove filler words** to cut every "um" and "uh" at the quiet moment around it. **Save version** renders a new MP4 with Intel hardware encoding when available and software encoding otherwise. The original recording is never changed.

Transcription runs locally with NVIDIA Parakeet TDT 0.6B v3. No audio leaves your computer. If the [Claude Code](https://claude.com/claude-code) command line tool is installed and signed in, VidCapture also uses it through your own Claude account. The punctuation pass sends the transcript text. Automatic titles send up to about 700 words of the transcript, the recording's length, and the name of the window or app on screen. Audio and video files are never sent. Set `CAPTURE_POLISH=off` to skip punctuation and `CAPTURE_TITLES=off` to skip automatic titles.

## Sharing

The first time you share, VidCapture opens vidcapture.stream so you can log in or create a free account (email and password, 5 GB of storage), then type the code the app shows. After that, sharing uploads directly. **Copy link** puts both the plain link and a linked animated card on the clipboard.

Only videos you share are uploaded. Anyone with an unlisted link can watch and download that video; links are not password-protected. Deleting a shared video revokes its link but cannot recall copies already downloaded.

To keep everything in your own Cloudflare account instead, [deploy your own sharing server](docs/sharing.md).

## Limitations

- Window mode follows a screen crop. Windows covering it appear in the video. Moving it to another display, hiding it, or closing it stops and saves the take.
- Notifications can appear in recordings. Turn on Omarchy's notification silencing first if that matters.
- Camera testing concentrated on a Razer Kiyo Pro Ultra and one built-in laptop webcam.
- Background effects need an NVIDIA GPU. There is no CPU fallback yet.
- Personalized audio enhancement is not included in this release; its action stays disabled.
- No captions export, password-protected links, team workspaces, or adaptive streaming.
- No macOS or Windows build, AUR package, or compatibility guarantee for other Wayland desktops.

## Uninstall

Quit VidCapture, then run `./uninstall.sh` from the checkout. It removes only VidCapture's own launcher entries and keeps your recordings, settings, sharing connection, and source. Optional features live in `~/.local/share/vidcapture-transcribe` and `~/.local/share/vidcapture-effects`; delete those folders to remove them.

## Development

```sh
npm test
```

Tests need FFmpeg and FFprobe on PATH. They cover recording arguments, camera lifecycle, geometry, editing and export, transcripts, uploads, and sharing-origin checks, and never upload anything. They do not establish clean-machine or broad GPU compatibility. See [verification](docs/verification.md) for what was checked for this release.

Use Issues for reproducible bugs. Include your Omarchy and Hyprland versions, GPU and driver, recording source, and the exact error. Never include publishing.json, sign-in links, or private recordings. Report vulnerabilities through GitHub's private security advisory flow.

## License and credits

VidCapture's own code is MIT licensed. The separately built GPU Screen Recorder helper and its patch remain GPL-3.0-only; see [engine/README.md](engine/README.md). Models and libraries that the optional setup scripts download keep their own licenses and are not part of this repository; see [THIRD_PARTY.md](THIRD_PARTY.md). VidCapture is an independent project, unaffiliated with Omarchy or Loom.
