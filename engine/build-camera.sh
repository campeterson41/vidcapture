#!/usr/bin/env bash
set -euo pipefail
capture_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$capture_root/.local/bin"
cc -O2 -Wall -Wextra -Werror "$capture_root/engine/camera-stream.c" -o "$capture_root/.local/bin/capture-camera-stream" $(pkg-config --cflags --libs libavformat libavcodec libavutil)
