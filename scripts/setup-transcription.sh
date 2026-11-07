#!/usr/bin/env bash
# Installs offline transcription for the editor's transcript and AI titles.
# Uses NVIDIA Parakeet TDT 0.6B v3 (int8, CC-BY-4.0) through sherpa-onnx on the CPU.
# Everything goes in ~/.local/share/vidcapture-transcribe (about 1 GB); nothing
# is installed system-wide and no audio ever leaves the computer.
set -euo pipefail
dest="${VIDCAPTURE_TRANSCRIBE_DIR:-$HOME/.local/share/vidcapture-transcribe}"
url="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2"
sha="1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9"
model="$dest/models/parakeet-tdt-0.6b-v3"

mkdir -p "$dest/models"
if [ ! -x "$dest/venv/bin/python" ]; then
  if command -v uv >/dev/null; then uv venv -q --python 3.11 "$dest/venv"; else python3 -m venv "$dest/venv"; fi
fi
if command -v uv >/dev/null; then pip=(uv pip install -q --python "$dest/venv/bin/python"); else pip=("$dest/venv/bin/python" -m pip install -q); fi
"${pip[@]}" sherpa-onnx==1.13.8 numpy soundfile scipy

if [ ! -f "$model/encoder.int8.onnx" ]; then
  tmp="$(mktemp -d "$dest/download.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 -o "$tmp/model.tar.bz2" "$url"
  echo "$sha  $tmp/model.tar.bz2" | sha256sum -c --status || { echo "The downloaded model did not match its expected checksum." >&2; exit 1; }
  tar -xjf "$tmp/model.tar.bz2" -C "$tmp"
  rm -rf "$model"; mkdir -p "$model"
  src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
  cp "$src"/encoder.int8.onnx "$src"/decoder.int8.onnx "$src"/joiner.int8.onnx "$src"/tokens.txt "$src"/README.md "$model/"
fi
"$dest/venv/bin/python" -c "import sherpa_onnx, soundfile, scipy"
echo "Transcription is installed in $dest. Restart VidCapture to use it."
