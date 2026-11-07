#!/usr/bin/env bash
# Registers the VidCapture extension's native host with Chromium and Chrome, and loads the
# unpacked extension in Chromium through ~/.config/chromium-flags.conf. Idempotent.
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
ext=$(dirname "$dir")
for browser in chromium google-chrome; do
  hosts="$HOME/.config/$browser/NativeMessagingHosts"
  [[ -d "$HOME/.config/$browser" ]] || continue
  mkdir -p "$hosts"
  printf '{\n  "name": "stream.vidcapture.launcher",\n  "description": "Opens the VidCapture desktop recorder",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": ["chrome-extension://dagpaflngbhbgpeichcnhalplkdmkfie/"]\n}\n' "$dir/vidcapture-native-host" > "$hosts/stream.vidcapture.launcher.json"
done
flags="$HOME/.config/chromium-flags.conf"
if [[ -f "$flags" ]] && ! grep -q -- "$ext" "$flags"; then
  if grep -q '^--load-extension=' "$flags"; then
    sed -i "0,/^--load-extension=/{s|^--load-extension=\(.*\)|--load-extension=\1,$ext|}" "$flags"
  else
    printf -- '--load-extension=%s\n' "$ext" >> "$flags"
  fi
fi
echo "VidCapture extension registered. It loads the next time Chromium starts."
