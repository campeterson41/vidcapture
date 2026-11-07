# Window-follow extension

Window mode uses a private build of GPU Screen Recorder 6.1.4, pinned to
`d2cff49dd5146941fde801186924b2a0e06da363`, with the adjacent GPL-3.0-only patch.
The system recorder and privileged KMS helper remain unchanged. Area/display
recordings continue to use the system recorder.

The patch updates the GPU crop from an owner-only, atomically replaced state
file. Capture tracks the selected Hyprland window's identity and bounds every
60 ms. Physical monitor coordinates account for display scaling. The output
canvas stays fixed; resizing preserves aspect ratio with letterboxing.
Stale state (over 750 ms), invalid geometry, or unavailable windows render black.
Capture stops and saves when the window disappears, crosses a display boundary,
or moves to another display. This is a moving screen crop: covering the selected
window with another app is visible in the recording.

Run `./engine/build.sh` to reproduce the private binary. The existing Arch build
libraries and uv are required. Build tools and headers stay under the selected
build directory. No package or system service is replaced. The build downloads the pinned upstream source, applies the included patch, and builds locally. No compiled upstream binary is distributed in this release.

Upstream: https://git.dec05eba.com/gpu-screen-recorder/about/
License: ../licenses/gpu-screen-recorder-GPL-3.0.txt
