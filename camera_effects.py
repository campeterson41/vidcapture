#!/usr/bin/env python3
"""Background blur and background replacement for the VidCapture camera bubble.

Runs between the camera and the bubble's mpv window when a background effect is
on. It decodes the camera, finds the person with Robust Video Matting (a
recurrent matting model, so edges stay steady from frame to frame), and
composites a blurred or replaced background on the NVIDIA GPU in one ONNX
Runtime pass. Square RGB frames go to stdout for mpv, which still applies lens
correction, lighting and the circular mask.

Input is either VidCapture's bounded camera transport (NUT on stdin, decoded on
the Intel GPU with VA-API) or a V4L2 device decoded by ffmpeg. Only the newest
frame is processed, so a slow frame never builds a backlog of old ones.

The model weights (GPL-3.0, PeterL1n/RobustVideoMatting) are installed
separately by scripts/setup-camera-effects.sh; this program only loads them.

Prints "ready" on stderr once the model is warm and the input is open.
Control socket: JSON lines {"mode":"blur"|"image","blur":0..1,"background":path}.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading

import numpy as np


def gaussian_taps(strength, taps=25):
    """Strength 0..1 becomes a separable Gaussian at 1/4 resolution."""
    sigma = 0.6 + 5.4 * float(np.clip(strength, 0, 1))
    x = np.arange(taps, dtype=np.float32) - taps // 2
    k = np.exp(-0.5 * (x / sigma) ** 2)
    k /= k.sum()
    kh = np.tile(k.reshape(1, 1, 1, taps), (4, 1, 1, 1)).astype(np.float32)
    kv = np.tile(k.reshape(1, 1, taps, 1), (4, 1, 1, 1)).astype(np.float32)
    return kh, kv


def fit_background(img, size):
    """Center-crops a replacement image to a square and scales it to the bubble."""
    import cv2
    h, w = img.shape[:2]
    s = min(h, w)
    img = img[(h - s) // 2:(h - s) // 2 + s, (w - s) // 2:(w - s) // 2 + s]
    return np.ascontiguousarray(cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA))


def load_image(path_):
    import cv2
    img = cv2.imread(path_, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('The background image could not be read.')
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


class Effect:
    """The fused matting and compositing graph, with recurrent state kept on the GPU."""

    def __init__(self, model, size, internal):
        import onnxruntime as ort
        ort.preload_dlls()
        ort.set_default_logger_severity(3)
        self.ort = ort
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers = [('CUDAExecutionProvider', {'device_id': 0, 'cudnn_conv_algo_search': 'HEURISTIC',
                                                'arena_extend_strategy': 'kSameAsRequested'})]
        self.s = ort.InferenceSession(model, opts, providers=providers)
        if 'CUDAExecutionProvider' not in self.s.get_providers():
            raise RuntimeError('Background effects need an NVIDIA GPU with CUDA.')
        self.size = size
        self.io = self.s.io_binding()
        V = lambda a: ort.OrtValue.ortvalue_from_numpy(a, 'cuda', 0)
        self.V = V
        self.ratio = V(np.array([internal / size], np.float32))
        self.rgb = V(np.zeros((size, size, 3), np.uint8))
        self.lock = threading.Lock()
        self.set_background(None)
        self.set_blur(0.6)
        self.reset()

    def reset(self):
        self.rec = [self.V(np.zeros((1, 1, 1, 1), np.float32)) for _ in range(4)]

    def set_background(self, img):
        sel = 0.0 if img is None else 1.0
        img = np.zeros((self.size, self.size, 3), np.uint8) if img is None else fit_background(img, self.size)
        with self.lock:
            self.bg = self.V(img)
            self.bgsel = self.V(np.array([sel], np.float32))

    def set_blur(self, strength):
        kh, kv = gaussian_taps(strength)
        with self.lock:
            self.kh, self.kv = self.V(kh), self.V(kv)

    def __call__(self, frame):
        self.rgb.update_inplace(frame)
        io = self.io
        io.clear_binding_inputs()
        io.clear_binding_outputs()
        with self.lock:
            for name, value in (('rgb', self.rgb), ('bg', self.bg), ('bgsel', self.bgsel), ('kh', self.kh),
                                ('kv', self.kv), ('downsample_ratio', self.ratio)):
                io.bind_ortvalue_input(name, value)
        for i, r in enumerate(self.rec):
            io.bind_ortvalue_input(f'r{i + 1}i', r)
        io.bind_output('out', 'cpu')
        io.bind_output('pha', 'cuda')
        for i in range(4):
            io.bind_output(f'r{i + 1}o', 'cuda')
        self.s.run_with_iobinding(io)
        outs = io.get_outputs()
        self.rec = outs[2:6]
        return outs[0].numpy()


def decoder(a):
    """An ffmpeg process that writes square RGB frames of the bubble size."""
    S = a.size
    common = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay',
              '-probesize', '32', '-analyzeduration', '0']
    env = dict(os.environ)
    if a.input == 'transport':
        env['LIBVA_DRIVER_NAME'] = 'iHD'
        env.pop('NVD_BACKEND', None)
        W = round(a.width * S / a.height / 2) * 2
        args = common + ['-hwaccel', 'vaapi', '-hwaccel_device', a.render, '-hwaccel_output_format', 'vaapi',
                         '-f', 'nut', '-i', 'pipe:0', '-fps_mode', 'passthrough',
                         '-vf', f'scale_vaapi=w={W}:h={S}:format=nv12:mode=hq,hwdownload,format=nv12,crop={S}:{S},format=rgb24']
        stdin = sys.stdin.buffer
    else:
        fmt = ['-input_format', a.format] if a.format else []
        args = common + ['-f', 'v4l2', *fmt, '-video_size', f'{a.width}x{a.height}', '-framerate', str(a.fps), '-i', a.device,
                         '-fps_mode', 'passthrough', '-vf', f'crop=ih:ih,scale={S}:{S}:flags=lanczos,format=rgb24']
        stdin = subprocess.DEVNULL
    args += ['-f', 'rawvideo', 'pipe:1']
    return subprocess.Popen(args, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, bufsize=0)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--model', required=True)
    ap.add_argument('--size', type=int, required=True)
    ap.add_argument('--internal', type=int, default=288, help='matting resolution inside the model')
    ap.add_argument('--input', choices=['transport', 'v4l2'], required=True)
    ap.add_argument('--render', default='', help='Intel render node for transport decoding')
    ap.add_argument('--device', default='')
    ap.add_argument('--width', type=int, required=True)
    ap.add_argument('--height', type=int, required=True)
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--format', default='')
    ap.add_argument('--mode', choices=['blur', 'image'], default='blur')
    ap.add_argument('--blur', type=float, default=0.6)
    ap.add_argument('--background', default='')
    ap.add_argument('--socket', default='')
    a = ap.parse_args()
    S = a.size
    if not 64 <= S <= 2160 or S % 2:
        raise SystemExit('Invalid bubble size.')

    fx = Effect(a.model, S, min(a.internal, S))
    fx.set_blur(a.blur)
    if a.mode == 'image':
        fx.set_background(load_image(a.background))
    blank = np.zeros((S, S, 3), np.uint8)
    for _ in range(3):
        fx(blank)
    fx.reset()

    ff = decoder(a)
    stop = threading.Event()
    latest = {'frame': None}
    ready = threading.Condition()
    errors = {'ff': ''}

    def read_frames():
        size = S * S * 3
        while not stop.is_set():
            buf = bytearray()
            while len(buf) < size:
                chunk = ff.stdout.read(size - len(buf))
                if not chunk:
                    stop.set()
                    with ready:
                        ready.notify()
                    return
                buf += chunk
            with ready:
                latest['frame'] = np.frombuffer(bytes(buf), np.uint8).reshape(S, S, 3)
                ready.notify()

    def read_errors():
        for line in iter(ff.stderr.readline, b''):
            errors['ff'] = (errors['ff'] + line.decode(errors='replace'))[-2000:]

    def control():
        if not a.socket:
            return
        srv = socket.socket(socket.AF_UNIX)
        srv.bind(a.socket)
        os.chmod(a.socket, 0o600)
        srv.listen(2)
        srv.settimeout(0.5)
        while not stop.is_set():
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            with conn:
                reply = {'ok': True}
                try:
                    for line in conn.makefile():
                        msg = json.loads(line)
                        if 'blur' in msg:
                            fx.set_blur(float(msg['blur']))
                        if msg.get('mode') == 'blur':
                            fx.set_background(None)
                        elif msg.get('mode') == 'image' or 'background' in msg:
                            fx.set_background(load_image(msg.get('background') or a.background))
                            if msg.get('background'):
                                a.background = msg['background']
                        break
                except Exception as e:  # report and keep running with the previous look
                    reply = {'ok': False, 'error': str(e)}
                try:
                    conn.sendall((json.dumps(reply) + '\n').encode())
                except OSError:
                    pass

    for target in (read_frames, read_errors, control):
        threading.Thread(target=target, daemon=True).start()

    out = sys.stdout.buffer
    announced = False
    try:
        while not stop.is_set():
            with ready:
                while latest['frame'] is None and not stop.is_set():
                    ready.wait(1.0)
                frame, latest['frame'] = latest['frame'], None
            if frame is None:
                break
            result = fx(frame)
            if not announced:
                print('ready', file=sys.stderr, flush=True)
                announced = True
            out.write(result.tobytes())
            out.flush()
    except BrokenPipeError:
        pass
    finally:
        stop.set()
        if ff.poll() is None:
            ff.terminate()
            try:
                ff.wait(2)
            except subprocess.TimeoutExpired:
                ff.kill()
        if errors['ff'] and not announced:
            print(errors['ff'].strip().splitlines()[-1], file=sys.stderr, flush=True)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(str(e) or e.__class__.__name__, file=sys.stderr, flush=True)
        sys.exit(1)
