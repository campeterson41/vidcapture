#!/usr/bin/env python3
"""Cut points for every transcript word, placed at quiet moments in the audio.

Parakeet's word start times are close, but it often reports a word's end about
0.2 s early, most of all for drawn-out fillers like um. Cutting at the reported
times leaves half an um behind. Each word therefore gets a cut start at the
quietest moment just around its reported start, and a cut end at the quietest
moment 0.1 to 0.32 s after its reported end, never far past the next word's
start. Measured on a real recording: cutting at the reported times left 12 of
16 ums audible; these cut points left 1 of 13 that the recognizer could hear.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf

STEP = 0.01


def envelope(x, sr):
    n = int(sr * STEP)
    frames = len(x) // n
    env = np.sqrt(np.mean(x[:frames * n].reshape(frames, n) ** 2, axis=1))
    return np.convolve(env, np.ones(3) / 3, mode='same')


def quietest(env, a, b, default):
    """Time of the quietest local minimum between a and b, else default."""
    lo, hi = max(1, int(round(a / STEP))), min(len(env) - 2, int(round(b / STEP)))
    best = None
    for k in range(lo, hi + 1):
        if env[k] <= env[k - 1] and env[k] <= env[k + 1] and (best is None or env[k] < env[best]):
            best = k
    return best * STEP if best is not None else default


def bounds(env, words, duration):
    out = []
    for i, w in enumerate(words):
        s, e = w['start'], w['end']
        a = quietest(env, s - 0.1, s + 0.08, s - 0.02)
        hi = e + 0.32
        if i + 1 < len(words):
            hi = min(hi, max(words[i + 1]['start'] + 0.1, e + 0.15))
        b = quietest(env, e + 0.1, hi, e + 0.1)
        a, b = max(0.0, a), min(duration, max(b, a + 0.08))
        out.append([round(a, 3), round(b, 3)])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--audio', type=Path, required=True)
    ap.add_argument('--words', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args()
    x, sr = sf.read(args.audio, dtype='float32')
    if x.ndim != 1:
        raise ValueError('Expected mono audio')
    words = json.loads(args.words.read_text())['words']
    result = bounds(envelope(x, sr), [{'start': w['start'], 'end': w['end']} for w in words], len(x) / sr)
    args.output.write_text(json.dumps(result))


if __name__ == '__main__':
    main()
