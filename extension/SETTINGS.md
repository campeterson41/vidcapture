# Extension recording settings parity

Inventory baseline: private main 2777e62, `ui/index.html`, `ui/app.js`, `recorder.cjs`, `camera-settings.cjs`, `camera-effects.cjs`, `audio-chain.cjs`, and main-process `actions`. Account, publishing service, admin, and developer configuration are excluded. Recording and camera lifetime remain owned by the installed app.

| Desktop setting or action | Existing key or service | Valid values | Extension entry | Persistence and behavior |
| --- | --- | --- | --- | --- |
| Source | `chooseTarget` / picker | Connected display, open window, drawn area, camera only | Record: Screen, Window, Area, Camera | Current session; source-kind guard required before Start |
| Camera | `camera` | `none` or enumerated device | Record: Camera | Recorder settings JSON; opening a different camera restarts its preview |
| Preview | `openCamera` / `closeCamera` | Explicit on/off | Record: Preview / Hide | Native camera process survives popup closure and navigation |
| Microphone | `microphone` | `none`, `default_input`, enumerated source | Record: Microphone | Recorder settings JSON |
| Computer audio | `systemAudio` | Boolean | Record; Audio | Recorder settings JSON |
| Bubble size | `cameraSize` | `small`, `medium`, `large` | Camera: Bubble size | Recorder settings JSON; position updates without camera restart |
| Bubble corner | `cameraCorner` | `bottom-left`, `bottom-right` | Camera: Position | Recorder settings JSON; clears manual placement |
| Manual bubble placement | Native window positioning | Drag native preview within target | Camera: placement instruction and Preview | Desktop owns geometry; no browser coordinate or filesystem RPC |
| Lens correction | `cameraCorrection` | `computer`, `off` | Camera: Lens correction | Recorder settings JSON; applies only to cameras with a matching correction profile |
| Lighting | `cameraLighting` | `original`, `balanced` | Camera: Lighting | Recorder settings JSON; same preview pipeline as desktop |
| Background | `cameraBackground` | `off`, `blur`, `image` | Record: Camera & background; Camera: Background | Recorder settings JSON; same installed GPU effects capability requirement |
| Blur strength | `cameraBlur` | `light`, `medium`, `strong` | Camera: Blur strength | Recorder settings JSON; updates live effect strength while idle preview is open |
| Background image | `cameraBackgroundImage` | Existing validated background basename or empty | Camera: Background image | Recorder settings JSON; updates the running idle effect |
| Add background | `actions.addBackground` | Native JPEG/PNG/WebP chooser, max 40 MB | Camera: Add image | Copies to app-owned backgrounds directory; no input path accepted by extension |
| Remove background | `actions.removeBackground` | Existing validated basename | Camera: Remove image, confirmation | Deletes chosen app-owned image; clears active image/mode as desktop does |
| Camera exposure | `CameraSettings` | All device-reported int/bool/menu controls: exposure, shutter, gain, backlight, low-light frame rate | Camera: Hardware controls | Saved per physical camera; re-applied on open; inactive auto-dependent fields disabled |
| Camera color | `CameraSettings` | Device-reported white balance, temperature, brightness, contrast, saturation, hue, gamma, sharpness | Camera: Hardware controls | Same validated device controls and per-camera file |
| Camera framing | `CameraSettings` | Device-reported autofocus, focus, zoom, pan, tilt | Camera: Hardware controls | Same validated device controls and per-camera file |
| Other camera controls | `CameraSettings` | Anti-flicker and every other supported int/bool/menu control | Camera: Hardware controls | Dynamic inventory; no fixed subset silently omitted |
| Reset camera | `actions.resetCameraControls` | Native device defaults | Camera: Reset controls, confirmation | Clears saved values for selected camera; no firmware write |
| Mic input level | `actions.setMicLevel` | Integer 0–150 percent | Audio: Microphone level | Current PipeWire source level, same as desktop; retained by audio server rather than recorder JSON |
| Noise removal | `micNoise` | `off`, `on` | Audio: Noise removal | Recorder settings JSON; same installed plugin capability |
| Voice gate | `micGate` | `off`, `gentle`, `strong` | Audio: Voice gate | Recorder settings JSON |
| Rumble filter | `micRumble` | Boolean | Audio: Rumble filter | Recorder settings JSON |
| Raw backup track | `micBackup` | Boolean | Audio: Backup microphone track | Recorder settings JSON; applies when live cleanup is enabled |
| Cleanup health / retry | `micCleanupError`, `saveSettings({})` / sync | Current health, explicit retry | Audio: status and Retry cleanup | Reuses existing health/recovery path; no chain changes during a take |
| Screen frame rate | `fps` | 30, 60 | Recording: Frame rate | Recorder settings JSON; camera-only mode uses its existing supported 30 fps selection |
| Quality | `quality` | `high`, `very_high`, `ultra` | Recording: Quality | Recorder settings JSON |
| Resolution | `resolution` | `0x0`, `1920x1080` | Recording: Resolution | Recorder settings JSON |
| Countdown | `countdown` | 0, 3 seconds | Recording: Countdown | Recorder settings JSON |
| Save location | `actions.chooseOutputDir` | Native directory chooser | Recording: Save location / Change | Existing location JSON; extension accepts no arbitrary path |
| Open save folder | `actions.openFolder` | Current authorized output folder | Recording: Open folder | Opens through installed app; no path input |
| Refresh devices | `actions.refreshDevices` | Current enumeration | Record: Refresh devices | Session state; keeps saved choices |
| Pause / resume / stop | Recorder methods | Explicit desired phase | Live recording panel | Idempotent pause/resume requests, stop saves locally |
| Restart / discard | `actions.restart` / `actions.discard` | Explicit confirmed live take | Live panel: More actions | Desktop behavior, discards only the current take; confirmation in popup |
| Shortcuts | Recorder `shortcuts` state | Installed Hyprland bindings | Recording: Keyboard shortcuts | Read-only display; no keybinding edits through extension |

All mutations are refused while another command, picker, recording transition, or processing job makes them unsafe. Recording settings and hardware controls are locked during a take. Settings views remain readable. Camera-only capture retains the desktop limitation: background effects are unavailable because the recorder reads the camera directly; the UI explains this and still permits turning an existing effect off. Missing effects/plugin capability is shown with an Open desktop action. Native dialogs and physical effect rendering need coordinated visible verification; headless protocol tests do not prove GPU rendering or chooser placement.
