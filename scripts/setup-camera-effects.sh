#!/usr/bin/env bash
# Installs background blur and replacement for the camera bubble.
# Needs an NVIDIA GPU with a CUDA-capable driver, plus uv (or python3 -m venv).
# Everything goes in ~/.local/share/vidcapture-effects; nothing is installed system-wide.
#
# The matting model is Robust Video Matting by Peter Lin et al., GPL-3.0,
# downloaded from its official GitHub release and checked against a fixed hash.
# It is loaded at run time by camera_effects.py and is not part of VidCapture's source.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${VIDCAPTURE_EFFECTS_DIR:-$HOME/.local/share/vidcapture-effects}"
url="https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx"
sha="88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828"

command -v nvidia-smi >/dev/null || { echo "Background effects need an NVIDIA GPU (nvidia-smi was not found)." >&2; exit 1; }
mkdir -p "$dest/models"
if [ ! -x "$dest/venv/bin/python" ]; then
  if command -v uv >/dev/null; then uv venv -q --python 3.11 "$dest/venv"; else python3 -m venv "$dest/venv"; fi
fi
if command -v uv >/dev/null; then pip=(uv pip install -q --python "$dest/venv/bin/python"); else pip=("$dest/venv/bin/python" -m pip install -q); fi
"${pip[@]}" "onnxruntime-gpu[cuda,cudnn]==1.31.1" numpy==1.26.4 opencv-python-headless==4.11.0.86 onnx==1.23.2

model="$dest/models/rvm_mobilenetv3_fp32.onnx"
if [ ! -f "$model" ] || ! echo "$sha  $model" | sha256sum -c --status; then
  tmp="$model.download"
  curl -fsSL --retry 3 -o "$tmp" "$url"
  echo "$sha  $tmp" | sha256sum -c --status || { rm -f "$tmp"; echo "The downloaded model did not match its expected checksum." >&2; exit 1; }
  mv "$tmp" "$model"
fi
"$dest/venv/bin/python" "$here/camera_effects_build.py" "$model" "$dest/models/camera-effects.onnx" >/dev/null
"$dest/venv/bin/python" - "$dest/models/camera-effects.onnx" <<'PY'
import sys, onnxruntime as ort
ort.set_default_logger_severity(3)
ort.preload_dlls()
s = ort.InferenceSession(sys.argv[1], providers=['CUDAExecutionProvider'])
if 'CUDAExecutionProvider' not in s.get_providers():
    sys.exit('CUDA is not available to ONNX Runtime on this computer.')
PY
cat > "$dest/MODEL-LICENSE.txt" <<TXT
camera-effects.onnx is built from Robust Video Matting (rvm_mobilenetv3_fp32.onnx),
Copyright Peter Lin and contributors, licensed under GPL-3.0:
https://github.com/PeterL1n/RobustVideoMatting
TXT
echo "Background effects are installed in $dest."
