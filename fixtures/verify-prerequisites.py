# SPDX-License-Identifier: AGPL-3.0-only
"""Execute media/schema checks and independent two-run prerequisite generation."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
STORE = Path(os.environ['CUTFRAME_FIXTURES'])
REPORT = ROOT / 'parity-reports/prerequisites'

def digest(file):
    return hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()

def decode(file, width, height):
    raw = subprocess.check_output(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(file),
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    return np.frombuffer(raw, np.uint8).reshape(-1, height, width, 3)

def main():
    REPORT.mkdir(parents=True, exist_ok=True)
    runs = []
    for label in ('a', 'b'):
        dest = REPORT / label
        subprocess.run([sys.executable, str(ROOT / 'fixtures/make-prerequisites.py')], check=True,
            stdout=subprocess.DEVNULL, env=dict(os.environ, CUTFRAME_PREREQUISITES_OUT=str(dest)))
        runs.append({p.name: digest(p) for p in sorted(dest.iterdir()) if p.is_file()})
    assert runs[0] == runs[1], 'Prerequisite generation is nondeterministic'
    for name, sha in runs[0].items():
        assert digest(STORE / 'prerequisites' / name) == sha, f'Stored prerequisite differs: {name}'
    checks = []
    for kind in ('shapes', 'text'):
        truth = np.load(STORE / f'prerequisites/OT-4-{kind}-truth.npz')
        colour, alpha, background = [truth[k].astype(np.int64) for k in ('colour', 'alpha', 'background')]
        recomputed = np.floor((colour * alpha[..., None] + background * (255 - alpha[..., None])) / 255 + 0.5).astype(np.uint8)
        assert np.array_equal(recomputed, truth['composite']), f'{kind} alpha composite formula'
        assert np.any(alpha == 255) and np.any(alpha == 0) and not np.any(alpha[30:36]), f'{kind} foreground/absence'
        assert np.array_equal(decode(STORE / f'prerequisites/OT-4-{kind}-composite.mkv', 160, 96), recomputed), f'{kind} decoded video exact pixels'
        checks.append(f'OT-4 {kind}: all60 decoded frames exact, integer composite exact, absence interval exact')
    packed = decode(STORE / 'prerequisites/FX-1-stacked-alpha.mkv', 320, 96)
    truth = np.load(STORE / 'prerequisites/FX-1-stacked-alpha-truth.npz')['rgba']
    assert np.array_equal(packed[:, :, :160], truth[:, :, :, :3])
    assert all(np.array_equal(packed[:, :, 160:, c], truth[:, :, :, 3]) for c in range(3))
    checks.append('FX-1: all60 decoded video colour and alpha halves exactly match straight RGBA truth')
    for file in sorted((STORE / 'prerequisites').glob('OT-5-*.json')):
        data = json.loads(file.read_text(encoding='utf-8'))
        with wave.open(str(file.with_suffix('.wav')), 'rb') as wav:
            assert wav.getframerate() == data['sampleRate'] == 48000
            samples = np.frombuffer(wav.readframes(wav.getnframes()), '<i2')
        assert len(samples) == data['durationSamples']
        assert all(abs(samples[b['sample']]) > 0 for b in data['beats'])
        assert all(b['timeMs'] == b['sample'] / 48000 * 1000 for b in data['beats'])
        assert all(b['downbeat'] == (i % data['meter'][0] == 0) for i, b in enumerate(data['beats']))
        checks.append(f'{file.stem}: {len(data["beats"])} exact sample onsets and bar labels checked')
    heavy = json.loads((STORE / 'prerequisites/FX-2-30min-1080p.json').read_text(encoding='utf-8'))
    assert heavy['schemaVersion'] == 4 and heavy['duration'] == 1800000 and heavy['size'] == {'width': 1920, 'height': 1080}
    assert heavy['items'][0]['display']['from'] == 0 and heavy['items'][-1]['display']['to'] == 1800000
    assert all(a['display']['to'] == b['display']['from'] for a, b in zip(heavy['items'], heavy['items'][1:]))
    # Stored shapes (findings (C).md:37-38, part 2 §29 and l.544): track `kind`, `{defaultValue, keyframes}` properties, positionX/Y.
    assert all('kind' in t and 'type' not in t for t in heavy['tracks'])
    assert all(set(i['properties']) >= {'positionX', 'positionY'} and not {'x', 'y'} & set(i['properties']) and all(set(p) == {'defaultValue', 'keyframes'} for p in i['properties'].values()) for i in heavy['items'])
    for item in heavy['items']:
        source = STORE / item['details']['src'].removeprefix('fixture://')
        assert source.is_file() and item['trim']['to'] <= item['sourceDuration']
    checks.append(f'FX-2: continuous30min1080p schema4 timeline, {len(heavy["items"])} valid media items')
    for count in (1, 5):
        p = json.loads((STORE / f'prerequisites/FX-2-{count}-threejs-60s.json').read_text(encoding='utf-8'))
        assert len(p['items']) == len(p['tracks']) == count
        assert all(i['display'] == {'from': 0, 'to': 60000} and 'ThreeCanvas' in i['details']['code'] and 'THREE.' not in i['details']['code'] for i in p['items'])
        # Stored shapes, as for the 30-minute project: track `kind`, {defaultValue, keyframes} properties, positionX/Y.
        assert all('kind' in t and 'type' not in t for t in p['tracks'])
        assert all(set(i['properties']) >= {'positionX', 'positionY'} and not {'x', 'y'} & set(i['properties']) and all(set(q) == {'defaultValue', 'keyframes'} for q in i['properties'].values()) for i in p['items'])
        checks.append(f'FX-2: {count} overlapping60s ThreeCanvas mesh projects; rendering belongs to T08/T16')
    report = {'status': 'passed', 'runs': runs, 'checks': checks}
    (REPORT / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'passed', 'files': len(runs[0]), 'checks': checks}, indent=2))

if __name__ == '__main__':
    main()
