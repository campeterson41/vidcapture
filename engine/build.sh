#!/usr/bin/env bash
set -euo pipefail
capture_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
capture_build="${CAPTURE_ENGINE_BUILD_DIR:-$HOME/.cache/capture-engine-build}"
mkdir -p "$capture_build"
if [[ ! -d "$capture_build/source" ]]; then
  git clone --depth 1 --branch 6.1.4 https://repo.dec05eba.com/gpu-screen-recorder "$capture_build/source"
fi
[[ "$(git -C "$capture_build/source" rev-parse HEAD)" == d2cff49dd5146941fde801186924b2a0e06da363 ]] || { echo 'Unexpected recorder source revision.' >&2; exit 1; }
if git -C "$capture_build/source" apply --reverse --check "$capture_root/engine/follow-region.patch" 2>/dev/null; then
  :
else
  git -C "$capture_build/source" apply --check "$capture_root/engine/follow-region.patch"
  git -C "$capture_build/source" apply "$capture_root/engine/follow-region.patch"
fi
if [[ ! -d "$capture_build/headers" ]]; then
  git init "$capture_build/headers"
  git -C "$capture_build/headers" remote add origin https://github.com/KhronosGroup/Vulkan-Headers.git
  git -C "$capture_build/headers" fetch --depth 1 origin 9fbc2a782ee3f8a4db64e7d991e23da75e893f44
  git -C "$capture_build/headers" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$capture_build/headers" rev-parse HEAD)" == 9fbc2a782ee3f8a4db64e7d991e23da75e893f44 ]] || { echo 'Unexpected Vulkan headers revision.' >&2; exit 1; }
if [[ ! -x "$capture_build/tools/bin/meson" ]]; then
  uv venv "$capture_build/tools"
  uv pip install --python "$capture_build/tools/bin/python" meson==1.12.1 ninja==1.13.2
fi
export PATH="$capture_build/tools/bin:$PATH"
if [[ ! -f "$capture_build/source/build/build.ninja" ]]; then
  meson setup "$capture_build/source/build" "$capture_build/source" --buildtype=release -Dffmpeg_static=false -Dcapabilities=false -Dsystemd=false -Dnvidia_suspend_fix=false "-Dc_args=-I$capture_build/headers/include"
fi
meson compile -C "$capture_build/source/build" -j 4
mkdir -p "$capture_root/.local/bin"
install -m755 "$capture_build/source/build/gpu-screen-recorder" "$capture_root/.local/bin/gpu-screen-recorder-follow"
echo 'Built the private window-follow recorder. System recorder unchanged.'
