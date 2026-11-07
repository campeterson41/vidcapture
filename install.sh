#!/usr/bin/env bash
set -euo pipefail
capture_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
capture_home="${CAPTURE_INSTALL_HOME:-$HOME}"
capture_launcher="$capture_home/.local/bin/capture"
capture_desktop="$capture_home/.local/share/applications/capture.desktop"
for capture_command in node python3 electron43 gpu-screen-recorder omarchy-capture-region hyprctl ffmpeg ffprobe mpv v4l2-ctl pactl; do
  command -v "$capture_command" >/dev/null || { echo "Missing required program: $capture_command" >&2; exit 1; }
done
if [[ -e "$capture_launcher" ]] && ! grep -q 'Capture local recorder launcher' "$capture_launcher"; then
  echo "An unrelated capture launcher already exists. It was preserved." >&2; exit 1
fi
if [[ -e "$capture_desktop" ]] && ! grep -q 'X-Capture-Owned=true' "$capture_desktop"; then
  echo "An unrelated Capture desktop entry already exists. It was preserved." >&2; exit 1
fi
if [[ ! -x "$capture_source/.local/bin/gpu-screen-recorder-follow" ]]; then
  echo "Build the window-follow helper with ./engine/build.sh before installing." >&2; exit 1
fi
if [[ ! -x "$capture_source/.local/bin/capture-camera-stream" ]]; then
  echo "Build the camera transport with ./engine/build-camera.sh before installing." >&2; exit 1
fi
mkdir -p "$capture_home/.local/bin" "$capture_home/.local/share/applications"
{
  printf '#!/usr/bin/env bash\n# Capture local recorder launcher\n'
  printf 'exec /usr/bin/node %q "$@"\n' "$capture_source/launch.cjs"
} > "$capture_launcher"
chmod 755 "$capture_launcher"
cat > "$capture_desktop" <<EOF
[Desktop Entry]
Type=Application
Name=VidCapture
Comment=Record, trim, and enhance local screen recordings
Exec="$capture_launcher"
Icon=$capture_source/ui/icon.png
Terminal=false
Categories=AudioVideo;Recorder;
StartupWMClass=capture
X-Capture-Owned=true
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$capture_home/.local/share/applications"
echo "Installed VidCapture in the app launcher."
