#!/usr/bin/env python3
"""Offline, word-timed transcription for VidCapture with NVIDIA Parakeet TDT 0.6B v3.

Runs locally through sherpa-onnx on the CPU. Nothing is uploaded. Long recordings
are read in 28-second windows with 2 seconds of context on each side; a word
belongs to the window that holds its midpoint, so windows join without
duplicates or gaps. Writes {"words":[{"word","start","end"}]} as JSON.

Installed by scripts/setup-transcription.sh. The model is CC-BY-4.0 (NVIDIA).
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf

WINDOW = 28
CONTEXT = 2


def token_words(tokens, timestamps, durations, offset=0.0, duration=math.inf):
    """Joins SentencePiece pieces into words, keeping their acoustic timestamps."""
    result, current = [], None
    for i, (piece, t) in enumerate(zip(tokens, timestamps)):
        if piece.startswith('<') and piece.endswith('>'):
            continue
        boundary = piece.startswith((' ', '▁'))
        text = piece.lstrip(' ▁')
        if not text:
            continue
        end = t + (durations[i] if i < len(durations) and durations[i] > 0 else 0.08)
        if boundary and current:
            result.append(current)
            current = None
        if current is None:
            current = {'word': text, 'start': max(0.0, offset + t), 'end': min(duration, offset + end)}
        else:
            current['word'] += text
            current['end'] = min(duration, offset + end)
    if current:
        result.append(current)
    return [w for w in result if w['end'] > w['start']]


def resample(x, rate):
    if rate == 16000:
        return x
    from scipy.signal import resample_poly
    g = math.gcd(rate, 16000)
    return resample_poly(x, 16000 // g, rate // g).astype(np.float32)


def transcribe(source, model, threads):
    import sherpa_onnx
    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(model / 'encoder.int8.onnx'), decoder=str(model / 'decoder.int8.onnx'),
        joiner=str(model / 'joiner.int8.onnx'), tokens=str(model / 'tokens.txt'),
        num_threads=threads, model_type='nemo_transducer')
    info = sf.info(source)
    rate, words = info.samplerate, []
    with sf.SoundFile(source) as f:
        for a in range(0, info.frames, rate * WINDOW):
            b = min(info.frames, a + rate * WINDOW)
            left, right = max(0, a - rate * CONTEXT), min(info.frames, b + rate * CONTEXT)
            f.seek(left)
            x = f.read(right - left, dtype='float32')
            if x.ndim != 1:
                raise ValueError('Expected mono audio.')
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, resample(x, rate))
            recognizer.decode_stream(stream)
            r = stream.result
            for w in token_words(r.tokens, r.timestamps, r.durations, left / rate, info.duration):
                mid = (w['start'] + w['end']) / 2
                if a / rate <= mid < b / rate and not (words and w['start'] < words[-1]['start']):
                    words.append(w)
            print(f'Transcribed {b / rate:.1f} / {info.duration:.1f}s', flush=True)
    return words, info.duration


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--input', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--model', type=Path, required=True)
    ap.add_argument('--engine', choices=['parakeet'], default='parakeet')
    ap.add_argument('--device', choices=['cpu', 'cuda'], default='cpu', help='accepted for compatibility; runs on the CPU')
    ap.add_argument('--threads', type=int, default=4)
    args = ap.parse_args()
    if not (args.model / 'encoder.int8.onnx').exists():
        raise SystemExit('The Parakeet model is not installed. Run scripts/setup-transcription.sh.')
    words, duration = transcribe(args.input, args.model, max(1, min(16, args.threads)))
    words = [w for w in words if math.isfinite(w['start']) and math.isfinite(w['end']) and 0 <= w['start'] < w['end'] <= duration + 0.05]
    if not words:
        raise SystemExit('No speech was recognized.')
    args.output.write_text(json.dumps({'schema': 'vidcapture-words/1', 'model': 'parakeet-tdt-0.6b-v3-int8', 'duration': duration, 'words': words}))


if __name__ == '__main__':
    main()
