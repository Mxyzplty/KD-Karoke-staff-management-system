# SPDX-License-Identifier: AGPL-3.0-only
"""Fetch public Google Groove test audio plus original MIDI/metronome labels.

HTTP Range reads the official ZIP central directory and selected members only.
Each extracted member's ZIP CRC is checked by zipfile and SHA-256 recorded. The
published full-archive hash is provenance, never claimed verified by a range read.
"""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import urllib.request
import zipfile
import mido

STORE = Path(os.environ['CUTFRAME_FIXTURES'])
OUT = STORE / 'datasets/groove'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'https://storage.googleapis.com/magentadata/datasets/groove/'
MIDI_SHA = '651cbc524ffb891be1a3e46d89dc82a1cecb09a57c748c7b45b844c4841dcc1e'
FULL_SHA = '21559feb2f1c96ca53988fd4d7060b1f2afe1d854fb2a8dcea5ff95cf3cce7e9'

class RemoteZip(io.RawIOBase):
    def __init__(self, url):
        self.url, self.position = url, 0
        request = urllib.request.Request(url, method='HEAD')
        with urllib.request.urlopen(request, timeout=45) as response:
            self.size = int(response.headers['Content-Length'])
        self.transferred = 0
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.position
    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
        return self.position
    def read(self, size=-1):
        size = self.size - self.position if size < 0 else min(size, self.size - self.position)
        if size <= 0: return b''
        request = urllib.request.Request(self.url, headers={'Range': f'bytes={self.position}-{self.position + size - 1}'})
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status != 206: raise RuntimeError('Server did not honor bounded Range request')
            data = response.read()
        if len(data) != size: raise RuntimeError('Short remote ZIP read')
        self.position += size
        self.transferred += size
        return data

def main():
    midi_zip = OUT / 'groove-v1.0.0-midionly.zip'
    if not midi_zip.exists():
        with urllib.request.urlopen(BASE + midi_zip.name, timeout=60) as response:
            midi_zip.write_bytes(response.read())
    assert hashlib.sha256(midi_zip.read_bytes()).hexdigest() == MIDI_SHA
    local = zipfile.ZipFile(midi_zip)
    info_name = next(n for n in local.namelist() if n.endswith('/info.csv'))
    info = local.read(info_name)
    (OUT / 'info.csv').write_bytes(info)
    rows = list(csv.DictReader(io.StringIO(info.decode('utf-8'))))
    # Three distinct released test performances, ordered deterministically.
    selected = []
    for row in sorted(rows, key=lambda r: r['id']):
        if row['split'] == 'test' and row['audio_filename'] and row['beat_type'] == 'beat' and float(row['duration']) < 35:
            if not selected or row['bpm'] not in [s['bpm'] for s in selected]: selected.append(row)
        if len(selected) == 3: break
    remote = RemoteZip(BASE + 'groove-v1.0.0.zip')
    full = zipfile.ZipFile(remote)
    records = []
    for row in selected:
        data = dict(row)
        for key in ('midi_filename', 'audio_filename'):
            filename = row[key]
            archive = local if key == 'midi_filename' else full
            member = next(n for n in archive.namelist() if n.endswith('/' + filename))
            raw = archive.read(member)
            target = OUT / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            data[key + '_sha256'] = hashlib.sha256(raw).hexdigest()
        midi = mido.MidiFile(OUT / row['midi_filename'])
        tempo, meter, tick = 500000, [4, 4], 0
        for message in mido.merge_tracks(midi.tracks):
            tick += message.time
            if message.type == 'set_tempo': tempo = message.tempo
            if message.type == 'time_signature': meter = [message.numerator, message.denominator]
        # GMD performers played to the specified metronome starting at zero.
        # Beat truth is this supplied grid, not every off-grid drum-note onset.
        duration, seconds_per_beat = float(row['duration']), tempo / 1000000
        beats, n = [], 0
        while n * seconds_per_beat < duration:
            beats.append({'timeMs': n * seconds_per_beat * 1000, 'downbeat': n % meter[0] == 0, 'beatInBar': n % meter[0] + 1})
            n += 1
        data.update({'tempoMicrosecondsPerQuarter': tempo, 'meter': meter, 'beats': beats,
            'truth': 'Released human-performed MIDI tempo/time signature + recording-aligned metronome grid; not manually tapped beats'})
        records.append(data)
        print('Acquired released test performance', row['id'], flush=True)
    license_record = {'name': 'Google Groove MIDI Dataset v1.0.0', 'url': 'https://magenta.tensorflow.org/datasets/groove',
        'license': 'CC-BY-4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by/4.0/',
        'attribution': 'Jon Gillick, Adam Roberts, Jesse Engel, Douglas Eck, David Bamman. Learning to Groove with Inverse Sequence Transformations, ICML2019. Google Magenta Groove MIDI Dataset.',
        'audio': 'Original released Roland TD-11 rendered audio of the human performance; no local MIDI resynthesis',
        'alignment': 'Dataset audio/MIDI aligned to within2ms per publisher; metronome truth explicitly distinguished from expressive note onsets',
        'midiArchiveSha256Verified': MIDI_SHA, 'fullArchivePublishedSha256': FULL_SHA,
        'fullArchiveSha256Verified': False, 'rangeBytesTransferred': remote.transferred, 'performances': records}
    (OUT / 'test-subset.json').write_text(json.dumps(license_record, indent=2) + '\n', encoding='utf-8')
    for p in sorted(OUT.rglob('*')):
        if p.is_file(): print(f'| `{p.relative_to(STORE).as_posix()}` | {p.stat().st_size} | `{hashlib.sha256(p.read_bytes()).hexdigest()}` |')

if __name__ == '__main__': main()
