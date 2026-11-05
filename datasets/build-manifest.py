# SPDX-License-Identifier: AGPL-3.0-only
"""Hash every T00-generated store file into the two manifests.

- datasets/manifest.json: the D14 record of open corpora and models (name, URL,
  licence, checksum) that T19 reads.
- fixtures/Cutframe test fixtures (C).md: rows between the T00 markers, which the
  fixture loader verifies before every media test run.
Checksums are always computed from the store bytes, never typed by hand.
"""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = Path(os.environ['CUTFRAME_FIXTURES'])
FIXTURES = ROOT / 'fixtures/Cutframe test fixtures (C).md'
BEGIN, END = '<!-- T00 generated rows: begin -->', '<!-- T00 generated rows: end -->'

def record(relative):
    path = STORE / relative
    return {'path': relative, 'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()}

def files(pattern):
    found = sorted(p.relative_to(STORE).as_posix() for p in STORE.glob(pattern) if p.is_file())
    if not found: raise SystemExit(f'No store files match {pattern}')
    return found

CC_BY_3 = ('CC-BY-3.0', 'https://creativecommons.org/licenses/by/3.0/')
CC_BY_4 = ('CC-BY-4.0', 'https://creativecommons.org/licenses/by/4.0/')
DATASETS = [
    {'id': 'OT-2', 'name': 'Tears of Steel official English subtitles, corrected against the audio and force-aligned',
     'url': 'https://download.blender.org/demo/movies/ToS/subtitles/TOS-en.srt', 'licence': CC_BY_3,
     'attribution': '"Tears of Steel" (c) Blender Foundation, mango.blender.org',
     'use': 'T19 transcript WER and word timing on the two corpus cut ranges',
     'files': files('datasets/speech/*.srt') + files('datasets/speech/*.json') + files('datasets/speech/*.npy')},
    {'id': 'OT-1', 'name': 'Speaker reference: consensus of two independent diarisation pipelines (CAM++, ERes2Net)',
     'url': 'derived from the corpus clips by datasets/prepare-speakers.py', 'licence': CC_BY_3,
     'attribution': '"Tears of Steel" (c) Blender Foundation, mango.blender.org',
     'use': 'T19 diarisation agreement on the two corpus cut ranges',
     'files': files('datasets/speakers/*')},
    {'id': 'OT-5', 'name': 'Google Groove MIDI Dataset v1.0.0, three released test performances (audio + MIDI + metronome grid)',
     'url': 'https://magenta.tensorflow.org/datasets/groove', 'licence': CC_BY_4,
     'attribution': 'Gillick, Roberts, Engel, Eck, Bamman. Learning to Groove with Inverse Sequence Transformations. ICML 2019.',
     'use': 'T19 beat F-measure on annotated real music (±70 ms)',
     'files': files('datasets/groove/**/*')},
    {'id': 'LibriSpeech', 'name': 'LibriSpeech test-clean', 'url': 'https://www.openslr.org/resources/12/test-clean.tar.gz',
     'licence': CC_BY_4, 'attribution': 'Panayotov, Chen, Povey, Khudanpur. LibriSpeech. ICASSP 2015. OpenSLR SLR12.',
     'use': 'T19 WER on read speech; downloaded and verified by the T19 run (346 MB)',
     'publisherChecksum': {'md5': '32fa31d27d2e1cad72775fee3f4849a9', 'source': 'https://www.openslr.org/resources/12/md5sum.txt'},
     'files': []},
    {'id': 'GEO-1', 'name': 'GeoNames cities15000 + countryInfo (offline reverse geocoder)', 'url': 'https://download.geonames.org/export/dump/',
     'licence': CC_BY_4, 'attribution': 'GeoNames (geonames.org), CC BY 4.0',
     'use': 'T14 Library location filter: GPS → "city, country" (datasets/prepare-geonames.py builds the bundle)',
     'bundle': {'path': 'apps/web/src/media/places.json', 'sha256': hashlib.file_digest((ROOT / 'apps/web/src/media/places.json').open('rb'), 'sha256').hexdigest()},
     'files': files('datasets/geonames/*')},
]
MODELS = [
    {'name': 'torchaudio WAV2VEC2_ASR_BASE_960H (OT-2 aligner)', 'url': 'https://download.pytorch.org/torchaudio/models/wav2vec2_fairseq_base_ls960_asr_ls960.pth',
     'licence': ('MIT', 'https://github.com/pytorch/fairseq/blob/ce6c9eeae163ac04b79539c78e74f292f29eaa18/LICENSE'),
     'files': files('models/torchaudio/*.pth')},
    {'name': 'OpenAI Whisper large-v3-turbo, sherpa-onnx ONNX export (OT-2 second audio check)', 'url': 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2',
     'licence': ('MIT', 'https://github.com/openai/whisper/blob/main/LICENSE'), 'files': files('models/asr/*.tar.bz2')},
    {'name': '3D-Speaker CAM++ and ERes2Net English VoxCeleb, sherpa-onnx ONNX exports (OT-1 pipelines)', 'url': 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models',
     'licence': ('Apache-2.0', 'https://www.apache.org/licenses/LICENSE-2.0'), 'files': files('models/speakers/*.onnx')},
]
FIXTURE_ROWS = files('synthetic/S5g-container-bitexact.mkv') + files('prerequisites/*') + \
    [f for d in DATASETS for f in d['files']]

def main():
    expand = lambda entry: {**entry, 'licence': entry['licence'][0], 'licenceUrl': entry['licence'][1], 'files': [record(f) for f in entry['files']]}
    manifest = {'version': 1, 'store': '$CUTFRAME_FIXTURES', 'datasets': [expand(d) for d in DATASETS], 'models': [expand(m) for m in MODELS]}
    (ROOT / 'datasets/manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    rows = '\n'.join(f"| `{r['path']}` | {r['bytes']} | `{r['sha256']}` |" for r in map(record, FIXTURE_ROWS))
    text = FIXTURES.read_text(encoding='utf-8')
    head, rest = text.split(BEGIN)
    _, tail = rest.split(END)
    FIXTURES.write_text(f'{head}{BEGIN}\n| File (store-relative) | Bytes | SHA-256 |\n|---|---|---|\n{rows}\n{END}{tail}', encoding='utf-8', newline='')
    print(f'{len(FIXTURE_ROWS)} fixture rows; {sum(len(d["files"]) for d in DATASETS)} dataset files; {sum(len(m["files"]) for m in MODELS)} model files')

if __name__ == '__main__': main()
