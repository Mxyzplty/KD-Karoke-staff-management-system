# SPDX-License-Identifier: AGPL-3.0-only
"""Regenerate independently: never overwrite the fixture reference store."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / 'parity-reports' / 'generation'
GENERATED = ['S1-framecount-1080x1920-30fps-10s.mp4', 'S2-framecount-tone-1920x1080-30fps-10s.mp4',
             'S3a-gradient-1080x1920.png', 'S3b-corpus-frame-tos-action-13s-1080x1920.png',
             'S3c-text-on-alpha-1080x1920.png', 'S4-black-1080x1920-3s.mp4', 'S5a-vfr.mp4',
             'S5b-hdr10-pq-hevc10.mp4', 'S5c-hlg-hevc10.mp4', 'S5d-rotation-90.mp4',
             'S5e-ac3-audio.mp4', 'S5f-eac3-audio.mp4', 'S5g-container-bitexact.mkv',
             'S5h-prores422.mov', 'S5i-hevc10-sdr.mp4']

def digest(path):
    return hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()

def main():
    store = os.environ.get('CUTFRAME_FIXTURES')
    if not store:
        raise SystemExit('CUTFRAME_FIXTURES must name the fixture store')
    version = subprocess.check_output(['ffmpeg', '-version'], text=True).splitlines()[0]
    expected = {m[0]: m[1] for m in re.findall(r'\| `([^`]+)` \| \d+ \| `([0-9a-f]{64})`', (ROOT / 'fixtures' / 'Cutframe test fixtures (C).md').read_text(encoding='utf-8'))}
    original_report = REPORTS / 'original-generator-report.json'
    if not original_report.exists() and (REPORTS / 'report.json').exists():
        prior = json.loads((REPORTS / 'report.json').read_text(encoding='utf-8'))
        if any(f['file'] == 'S5g-container.mkv' for f in prior['failures']):
            original_report.write_text(json.dumps(prior, indent=2) + '\n', encoding='utf-8')
    runs = []
    for run in ('a', 'b'):
        dest = REPORTS / run
        dest.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, CUTFRAME_SYNTHETIC_OUT=str(dest))
        subprocess.run([sys.executable, str(ROOT / 'fixtures' / 'make_synthetic.py')], check=True, env=env)
        # Ignore stale files from a previous generator version; compare the
        # declared current set only. The original random-UID MKV is reference-only.
        runs.append({name: digest(dest / name) for name in GENERATED})
    failures = []
    # The recorded MP4 hashes were made with ffmpeg 8.1.2; any other version may change the bytes.
    recorded = re.match(r'ffmpeg version 8\.1\.2(?![0-9])', version) is not None
    for name, sha in runs[0].items():
        if sha != runs[1].get(name):
            failures.append({'file': name, 'reason': 'not deterministic', 'a': sha, 'b': runs[1].get(name)})
        if name.endswith('.mp4') and recorded and expected.get(name) != sha:
            failures.append({'file': name, 'reason': 'recorded MP4 hash mismatch', 'expected': expected.get(name), 'actual': sha})
    check = 'checked' if recorded else 'recorded-hash check skipped (ffmpeg ≠ 8.1.2)'
    report = {'ffmpeg': version, 'recordedMp4Hashes': check, 'runs': runs, 'failures': failures}
    (REPORTS / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'outputs': len(runs[0]), 'recordedMp4Hashes': check, 'failures': failures}, indent=2))
    return bool(failures)

if __name__ == '__main__':
    sys.exit(main())
