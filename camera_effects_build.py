#!/usr/bin/env python3
"""Wrap Robust Video Matting in one ONNX graph that also does the camera-bubble effect.

Inputs (all stay on the GPU except `rgb`):
  rgb      uint8 [H, W, 3]   bubble-size camera frame (center square)
  bg       uint8 [H, W, 3]   replacement image, already cropped to the bubble
  bgsel    float [1]         1 = replacement image, 0 = blurred camera background
  kh, kv   float [4,1,1,K] / [4,1,K,1]  separable Gaussian taps (blur strength)
  r1i..r4i, downsample_ratio  RVM recurrent state and internal resolution
Outputs:
  out      uint8 [H, W, 3]   composited frame for mpv (circular mask stays in mpv)
  pha      float [1,1,H,W]   matte (kept on the GPU unless requested)
  r1o..r4o recurrent state, fed back each frame

The background blur is a masked (normalized) blur computed at 1/4 resolution:
blur(src * (1 - a)) / blur(1 - a), so the person never bleeds a halo into the
blurred background. Then out = fgr * a + background * (1 - a), using RVM's
color-decontaminated foreground for clean hair edges.

Used by scripts/setup-camera-effects.sh. Usage:
  camera_effects_build.py rvm_mobilenetv3_fp32.onnx camera-effects.onnx [--taps 25] [--pool 4]
"""
import argparse
import numpy as np
import onnx
from onnx import helper as h, TensorProto as T, numpy_helper as nh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--taps', type=int, default=25)
    ap.add_argument('--pool', type=int, default=4)
    a = ap.parse_args()
    m = onnx.load(a.src)
    g = m.graph
    fp16 = [i for i in g.input if i.name == 'src'][0].type.tensor_type.elem_type == T.FLOAT16
    rdt = T.FLOAT16 if fp16 else T.FLOAT
    for n in g.node:
        for i, name in enumerate(n.input):
            if name == 'src':
                n.input[i] = 'src_model'
    keep = [i for i in g.input if i.name != 'src']
    del g.input[:]
    g.input.extend(keep)
    # Rename model outputs so the wrapper can post-process fgr/pha.
    for n in g.node:
        for i, name in enumerate(n.output):
            if name in ('fgr', 'pha'):
                n.output[i] = name + '_model'
    outs = [o for o in g.output if o.name not in ('fgr', 'pha')]
    del g.output[:]

    K = a.taps
    P = a.pool
    inits = [
        nh.from_array(np.array([1 / 255], np.float32), 'k_inv255'),
        nh.from_array(np.array([1.0], np.float32), 'k_one'),
        nh.from_array(np.array([255.0], np.float32), 'k_255'),
        nh.from_array(np.array([0.5], np.float32), 'k_half'),
        nh.from_array(np.array([1e-3], np.float32), 'k_eps'),
        nh.from_array(np.array([0, 0, K // 2, K // 2, 0, 0, K // 2, K // 2], np.int64), 'k_pads'),
        nh.from_array(np.array([1, 1, P, P], np.float32), 'k_upscale'),
        nh.from_array(np.array([], np.float32), 'k_roi'),
        nh.from_array(np.array([0], np.int64), 'k_s0'),
        nh.from_array(np.array([3], np.int64), 'k_s3'),
        nh.from_array(np.array([4], np.int64), 'k_s4'),
        nh.from_array(np.array([1], np.int64), 'k_ax1'),
    ]
    N = []
    add = lambda op, i, o, **kw: N.append(h.make_node(op, i, o, **kw))
    # Preprocess: uint8 HWC -> float NCHW in [0, 1].
    add('Cast', ['rgb'], ['rgb_f'], to=T.FLOAT)
    add('Transpose', ['rgb_f'], ['rgb_chw'], perm=[2, 0, 1])
    add('Unsqueeze', ['rgb_chw'], ['rgb_nchw'], axes=[0])
    add('Mul', ['rgb_nchw', 'k_inv255'], ['src_f'])
    if fp16:
        add('Cast', ['src_f'], ['src_model'], to=T.FLOAT16)
        add('Cast', ['pha_model'], ['pha_raw'], to=T.FLOAT)
        add('Cast', ['fgr_model'], ['fgr_f'], to=T.FLOAT)
    else:
        add('Identity', ['src_f'], ['src_model'])
        add('Identity', ['pha_model'], ['pha_raw'])
        add('Identity', ['fgr_model'], ['fgr_f'])
    # Opset 12 Clip takes min/max as inputs.
    inits += [nh.from_array(np.array(0.0, np.float32), 'k_zero_s'), nh.from_array(np.array(1.0, np.float32), 'k_one_s')]
    add('Clip', ['pha_raw', 'k_zero_s', 'k_one_s'], ['pha'])
    add('Sub', ['k_one', 'pha'], ['inv'])
    # Masked blur at 1/P resolution.
    add('Mul', ['src_f', 'inv'], ['src_bg'])
    add('Concat', ['src_bg', 'inv'], ['bg4'], axis=1)
    add('AveragePool', ['bg4'], ['bg4s'], kernel_shape=[P, P], strides=[P, P])
    add('Pad', ['bg4s', 'k_pads'], ['bg4p'], mode='reflect')
    add('Conv', ['bg4p', 'kh'], ['bg4h'], group=4)
    add('Conv', ['bg4h', 'kv'], ['bg4b'], group=4)
    add('Resize', ['bg4b', 'k_roi', 'k_upscale'], ['bg4u'], mode='linear')
    add('Slice', ['bg4u', 'k_s0', 'k_s3', 'k_ax1'], ['bgnum'])
    add('Slice', ['bg4u', 'k_s3', 'k_s4', 'k_ax1'], ['bgden'])
    add('Max', ['bgden', 'k_eps'], ['bgden_c'])
    add('Div', ['bgnum', 'bgden_c'], ['bgblur'])
    # Replacement image.
    add('Cast', ['bg'], ['bg_f'], to=T.FLOAT)
    add('Transpose', ['bg_f'], ['bg_chw'], perm=[2, 0, 1])
    add('Unsqueeze', ['bg_chw'], ['bg_nchw'], axes=[0])
    add('Mul', ['bg_nchw', 'k_inv255'], ['bgimg'])
    # background = bgsel * image + (1 - bgsel) * blur
    add('Sub', ['bgimg', 'bgblur'], ['bgdiff'])
    add('Mul', ['bgdiff', 'bgsel'], ['bgdiff_s'])
    add('Add', ['bgblur', 'bgdiff_s'], ['background'])
    # composite = fgr * a + background * (1 - a)
    add('Clip', ['fgr_f', 'k_zero_s', 'k_one_s'], ['fgr_c'])
    add('Sub', ['fgr_c', 'background'], ['fdiff'])
    add('Mul', ['fdiff', 'pha'], ['fdiff_a'])
    add('Add', ['background', 'fdiff_a'], ['comp'])
    add('Clip', ['comp', 'k_zero_s', 'k_one_s'], ['comp_c'])
    add('Mul', ['comp_c', 'k_255'], ['comp_255'])
    add('Add', ['comp_255', 'k_half'], ['comp_r'])
    add('Squeeze', ['comp_r'], ['comp_chw'], axes=[0])
    add('Transpose', ['comp_chw'], ['comp_hwc'], perm=[1, 2, 0])
    add('Cast', ['comp_hwc'], ['out'], to=T.UINT8)

    # Preprocess nodes (everything up to src_model) go first; the rest after the model.
    split = max(i for i, n in enumerate(N) if 'src_model' in n.output) + 1
    model_nodes = list(g.node)
    del g.node[:]
    g.node.extend(N[:split] + model_nodes + N[split:])
    g.initializer.extend(inits)
    g.input.extend([
        h.make_tensor_value_info('rgb', T.UINT8, ['H', 'W', 3]),
        h.make_tensor_value_info('bg', T.UINT8, ['H', 'W', 3]),
        h.make_tensor_value_info('bgsel', T.FLOAT, [1]),
        h.make_tensor_value_info('kh', T.FLOAT, [4, 1, 1, K]),
        h.make_tensor_value_info('kv', T.FLOAT, [4, 1, K, 1]),
    ])
    g.output.extend([h.make_tensor_value_info('out', T.UINT8, ['H', 'W', 3]),
                     h.make_tensor_value_info('pha', T.FLOAT, [1, 1, 'H', 'W'])] + outs)
    onnx.checker.check_model(m)
    onnx.save(m, a.dst)
    print('wrote', a.dst, 'fp16' if fp16 else 'fp32', 'recurrent dtype', rdt)


if __name__ == '__main__':
    main()
