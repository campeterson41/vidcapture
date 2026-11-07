# Third-party components

## Included in this repository

Interface SVG icons are adapted from Tabler Icons by Paweł Kuna, MIT: https://github.com/tabler/tabler-icons . License: licenses/tabler-icons-MIT.txt.

The circular webcam technique was informed by https://github.com/SomeoneWithOptions/loom-omarchy-linux . Its MIT notice is preserved in licenses/loom-omarchy-linux-MIT.txt.

The browser video card preview uses gifenc 1.0.3. Its license is in cloud/public/gifenc-LICENSE.md.

Window following builds GPU Screen Recorder 6.1.4 from its pinned upstream source with the included GPL-3.0-only patch. Source revision, patch, upstream link, and reproduction steps are in engine/. Full license: licenses/gpu-screen-recorder-GPL-3.0.txt. No precompiled helper is distributed.

The interface was developed with AI assistance. No paid design product or upstream application bundle is included.

## Downloaded by the optional setup scripts

None of these are stored in this repository. Each script downloads them into your home folder from their original publishers, and checks model files against a fixed SHA-256 checksum.

**scripts/setup-transcription.sh**

- NVIDIA Parakeet TDT 0.6B v3, int8 conversion published by the sherpa-onnx project. CC-BY-4.0. Model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 . Conversion: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models . The model's README is kept next to the installed files.
- sherpa-onnx, Apache-2.0: https://github.com/k2-fsa/sherpa-onnx . Installed from PyPI with NumPy, SciPy, and soundfile under their own licenses.

**scripts/setup-camera-effects.sh**

- Robust Video Matting, MobileNetV3 weights, by Shanchuan Lin and others. GPL-3.0: https://github.com/PeterL1n/RobustVideoMatting . Downloaded from its v1.0.0 release and combined locally into the effect graph on your computer. VidCapture runs it in a separate process (camera_effects.py) and does not distribute the weights or the combined graph.
- ONNX Runtime GPU 1.31.1, MIT: https://github.com/microsoft/onnxruntime . Its CUDA and cuDNN dependencies are NVIDIA's own packages under NVIDIA's license terms, installed from PyPI.
- ONNX, Apache-2.0; NumPy, BSD-3-Clause; OpenCV, Apache-2.0. Installed from PyPI.

## Used from your system

VidCapture invokes system Electron, GPU Screen Recorder, MPV, FFmpeg, PipeWire and PulseAudio utilities, v4l2 utilities, Omarchy, and Hyprland. Noise removal loads the RNNoise LADSPA plugin from the noise-suppression-for-voice package (GPL-3.0, https://github.com/werman/noise-suppression-for-voice) through PipeWire's filter chain. Optional transcript polish and titles call the Claude Code command line tool if you have installed it. All of these keep their own licenses and are installed separately.
