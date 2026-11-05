# SPDX-License-Identifier: AGPL-3.0-only
"""BeatThis checkpoint -> ONNX (T19a new-model round, BEAT-P02). Run only by `prepare.py beat-export`,
inside the pinned export venv, with the hash-checked beat_this source tree passed as the first argument.

The graph takes the log-mel spectrogram `spect` [1, frames, 128] and returns the beat and downbeat
logits [1, frames]. The rotary-position cache is switched off so positions follow the traced length
and the time axis stays dynamic (inference.py feeds chunks of 1500 frames and shorter single chunks).
Exits non-zero unless onnxruntime matches PyTorch on a full and a short chunk.
"""
import inspect
import sys

source, checkpoint_path, out = sys.argv[1:4]
sys.path.insert(0, source)

import numpy as np  # noqa: E402
import onnxruntime  # noqa: E402
import torch  # noqa: E402
from rotary_embedding_torch import RotaryEmbedding  # noqa: E402
from beat_this.model.beat_tracker import BeatThis  # noqa: E402
from beat_this.utils import replace_state_dict_key  # noqa: E402


class Logits(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spect):
        prediction = self.model(spect)
        return prediction["beat"], prediction["downbeat"]


# Same construction as beat_this.inference.load_model.
checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
hparams = {k: v for k, v in checkpoint["hyper_parameters"].items() if k in set(inspect.signature(BeatThis).parameters)}
model = BeatThis(**hparams)
model.load_state_dict(replace_state_dict_key(checkpoint["state_dict"], "model.", ""))
model.eval()
for module in model.modules():
    if isinstance(module, RotaryEmbedding):
        module.cache_if_possible = False
wrapped = Logits(model).eval()
generator = torch.Generator().manual_seed(0)
example = torch.rand(1, 1500, 128, generator=generator) * 4
with torch.no_grad():
    torch.onnx.export(wrapped, (example,), out, input_names=["spect"], output_names=["beat", "downbeat"],
                      dynamic_axes={"spect": {1: "frames"}, "beat": {1: "frames"}, "downbeat": {1: "frames"}},
                      opset_version=17, do_constant_folding=True, dynamo=False)

session = onnxruntime.InferenceSession(out, providers=["CPUExecutionProvider"])
worst = 0.0
for frames in (1500, 762):
    spect = torch.rand(1, frames, 128, generator=generator) * 4
    with torch.no_grad():
        expected = [t.numpy() for t in wrapped(spect)]
    actual = session.run(None, {"spect": spect.numpy()})
    worst = max(worst, *(float(np.abs(a - e).max()) for a, e in zip(actual, expected)))
print(f"hparams {hparams}")
print(f"max |onnx - torch| logit difference {worst:.2e}")
sys.exit(0 if worst < 1e-3 else 1)
