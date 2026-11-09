#!/usr/bin/env bash
set -euo pipefail
capture_home="${CAPTURE_INSTALL_HOME:-$HOME}"
capture_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
/usr/bin/node "$capture_source/desktop-links.cjs" remove "$capture_home" || echo "The website update link could not be removed." >&2
capture_launcher="$capture_home/.local/bin/capture"
capture_desktop="$capture_home/.local/share/applications/capture.desktop"
if [[ -f "$capture_launcher" ]] && grep -q 'Capture local recorder launcher' "$capture_launcher"; then rm -- "$capture_launcher"; fi
if [[ -f "$capture_desktop" ]] && grep -q 'X-Capture-Owned=true' "$capture_desktop"; then rm -- "$capture_desktop"; fi
if command -v update-desktop-database >/dev/null; then update-desktop-database "$capture_home/.local/share/applications"; fi
echo 'VidCapture launcher removed. Recordings, settings, sharing keys, and source files were preserved.'
