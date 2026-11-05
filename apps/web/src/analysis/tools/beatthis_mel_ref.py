# SPDX-License-Identifier: AGPL-3.0-only
"""Dev-only generator of tests/fixtures/beatthis-mel.json (T19q B4): the torchaudio log-mel of a closed-form
0.5 s signal, the reference that tests/t19q-beatthis.test.ts holds `logMel` (beatthis.ts) to.

beat_this @ b95c8ab0 preprocessing.LogMelSpect: MelSpectrogram(sample_rate=22050, n_fft=1024, hop_length=441,
f_min=30, f_max=11000, n_mels=128, mel_scale="slaney", normalized="frame_length", power=1), then log1p(1000 x).

Run from the repo root, in bash (PowerShell 5.1's `>` writes UTF-16), with the export venv's python:
  "$LOCALAPPDATA/Cutframe/beat-this-export-venv/Scripts/python.exe" -I apps/web/src/analysis/tools/beatthis_mel_ref.py > tests/fixtures/beatthis-mel.json
The signal is defined in float64 and cast to float32 once; the test rebuilds it the same way and checks `hash`.
The reference is float64 throughout, as the port computes: the float32 samples upcast (both sides see identical input),
and the default dtype set before the transform is built, because `.double()` only casts a window and filterbank already
built in float32.
"""
import json
import math

import numpy as np
import torch
import torchaudio

RATE, LENGTH = 22050, 11025


def signal():
    out = np.empty(LENGTH, dtype=np.float64)
    for n in range(LENGTH):
        out[n] = 0.5 * math.sin(2 * math.pi * 440 * n / RATE) + 0.25 * math.sin(2 * math.pi * 3000 * n / RATE) + (0.8 if n % 2205 == 0 else 0)
    return out.astype(np.float32)


def fnv1a(data):
    h = 2166136261
    for b in data.tobytes():
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h


x = signal()
torch.set_default_dtype(torch.float64)
mel = torchaudio.transforms.MelSpectrogram(sample_rate=RATE, n_fft=1024, hop_length=441, f_min=30, f_max=11000, n_mels=128,
                                           mel_scale="slaney", normalized="frame_length", power=1)
spect = torch.log1p(1000 * mel(torch.from_numpy(x.astype(np.float64)))).T.contiguous().numpy()  # [frames][128]
print(json.dumps({"rate": RATE, "length": LENGTH, "hash": fnv1a(x), "frames": spect.shape[0], "mels": spect.shape[1],
                  "spect": [[round(float(v), 6) for v in row] for row in spect]}, separators=(",", ":")))
