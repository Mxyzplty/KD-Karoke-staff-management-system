# SPDX-License-Identifier: AGPL-3.0-only
"""Two independent open speaker-embedding/VAD/clustering diarization pipelines.

Consensus is label-permutation invariant. Only speech intervals in the aligned
transcript are scorable; silence/music agreement never increases coverage.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import numpy as np
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.optimize import linear_sum_assignment
from scipy.spatial.distance import pdist
import kaldi_native_fbank as knf
import onnxruntime as ort

STORE = Path(os.environ['CUTFRAME_FIXTURES'])
OUT = STORE / 'datasets/speakers'
OUT.mkdir(parents=True, exist_ok=True)
MODELS = STORE / 'models/speakers'
MODELS.mkdir(parents=True, exist_ok=True)
ARCHITECTURES = [('campplus', .25, 1.5, .38, 35), ('eres2net', .32, 1.8, .42, 45)]

def acquire():
    records = []
    for architecture, *_ in ARCHITECTURES:
        publisher = f'https://www.modelscope.cn/api/v1/models/iic/speech_{architecture}_sv_en_voxceleb_16k'
        with urllib.request.urlopen(publisher, timeout=30) as response:
            card = json.load(response)
        license_name = card['Data']['License']
        assert license_name == 'Apache License 2.0', f'Unexpected publisher license: {license_name}'
        name = f'3dspeaker_speech_{architecture}_sv_en_voxceleb_16k.onnx'
        target = MODELS / name
        url = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/' + name
        if not target.exists():
            with urllib.request.urlopen(url, timeout=60) as response:
                target.write_bytes(response.read())
        records.append({'architecture': architecture, 'license': 'Apache-2.0', 'publisherApi': publisher,
            'publisherLicense': license_name, 'publisherRevision': 'v1.0.2', 'url': url,
            'file': target.relative_to(STORE).as_posix(), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size})
        print('Downloaded', architecture, records[-1]['sha256'], flush=True)
    # Preserve actual checked publisher cards; the manifest exists before inference.
    (OUT / 'models.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    return records

def features(samples, metadata):
    opts = knf.FbankOptions()
    opts.frame_opts.dither = 0
    opts.frame_opts.samp_freq = int(metadata['sample_rate'])
    opts.frame_opts.snip_edges = True
    opts.mel_opts.num_bins = 80
    opts.mel_opts.debug_mel = False
    fbank = knf.OnlineFbank(opts)
    fbank.accept_waveform(int(metadata['sample_rate']), samples if int(metadata['normalize_samples']) else samples * 32768)
    fbank.input_finished()
    values = np.stack([fbank.get_frame(i) for i in range(fbank.num_frames_ready)])
    if metadata['feature_normalize_type'] == 'global-mean': values -= values.mean(axis=0, keepdims=True)
    elif metadata['feature_normalize_type'] != 'none': raise RuntimeError('Unsupported feature normalization')
    return values.astype(np.float32)[None]

def pipeline(audio, architecture, hop, width, threshold, percentile):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = opts.inter_op_num_threads = 1
    session = ort.InferenceSession(str(MODELS / f'3dspeaker_speech_{architecture}_sv_en_voxceleb_16k.onnx'), sess_options=opts, providers=['CPUExecutionProvider'])
    metadata = session.get_modelmeta().custom_metadata_map
    assert int(metadata['sample_rate']) == 16000
    # Independent energy VAD per pipeline; architecture, segmentation/hop,
    # floor percentile and clustering threshold are fixed before comparison.
    energies = [np.sqrt(np.mean(audio[i:i + 320] ** 2)) for i in range(0, len(audio) - 320, 160)]
    floor = max(float(np.percentile(energies, percentile)) * 1.15, .003)
    windows, embeddings = [], []
    for start in np.arange(0, len(audio) / 16000 - .4, hop):
        end = min(start + width, len(audio) / 16000)
        samples = audio[int(start * 16000):int(end * 16000)]
        if np.sqrt(np.mean(samples ** 2)) < floor: continue
        x = features(samples, metadata)
        embedding = session.run(None, {session.get_inputs()[0].name: x})[0].reshape(-1)
        embedding /= max(np.linalg.norm(embedding), 1e-12)
        windows.append({'startMs': float(start * 1000), 'endMs': float(end * 1000)})
        embeddings.append(embedding)
    if not embeddings: raise RuntimeError(f'{architecture} produced no speech candidates')
    embeddings = np.array(embeddings)
    labels = fcluster(linkage(pdist(embeddings, metric='cosine'), method='average'), threshold, criterion='distance') if len(embeddings) > 1 else [1]
    for segment, label in zip(windows, labels): segment['speaker'] = int(label)
    return {'modelMetadata': metadata, 'vad': {'method': 'RMS energy20ms/10ms', 'floor': floor, 'floorPercentile': percentile},
        'windowSeconds': width, 'hopSeconds': hop, 'clusterMethod': 'average-linkage cosine distance',
        'clusterThreshold': threshold, 'clusterCountInferred': int(max(labels)), 'segments': windows}, embeddings

def label_at(raw, time):
    segments = [s for s in raw['segments'] if s['startMs'] <= time < s['endMs']]
    if not segments: return None
    # Nearest window centre; overlapping windows never count twice.
    return min(segments, key=lambda s: abs((s['startMs'] + s['endMs']) / 2 - time))['speaker']

def main():
    acquire()
    for clip in ('tos-speech-45s', 'tos-action-30s'):
        raw = subprocess.check_output(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(STORE / 'corpus' / (clip + '.mp4')), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
        audio = np.frombuffer(raw, '<f4')
        outputs = []
        for spec in ARCHITECTURES:
            result, embeddings = pipeline(audio, *spec)
            name = f'{clip}-{spec[0]}'
            np.save(OUT / (name + '-embeddings.npy'), embeddings)
            (OUT / (name + '.json')).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
            outputs.append(result)
            print(clip, spec[0], 'inferred clusters', result['clusterCountInferred'], flush=True)
        transcript = json.loads((STORE / f'datasets/speech/{clip}-aligned.json').read_text(encoding='utf-8'))
        # Only reliably timed OT-2 words define scorable speech.
        speech = [(w['startMs'], w['endMs'], w['cue']) for w in transcript['words'] if w['timingScorable']]
        grid = np.arange(0, len(audio) / 16, 10)
        cue_at = lambda t: next((cue for start, end, cue in speech if start <= t < end), None)
        pairs = [(t, label_at(outputs[0], t), label_at(outputs[1], t), cue_at(t)) for t in grid if cue_at(t) is not None]
        matrix = np.zeros((outputs[0]['clusterCountInferred'], outputs[1]['clusterCountInferred']), dtype=int)
        for _, a, b, _ in pairs:
            if a is not None and b is not None: matrix[a - 1, b - 1] += 1
        row, col = linear_sum_assignment(-matrix)
        permutation = {int(b + 1): int(a + 1) for a, b in zip(row, col)}
        agree = lambda a, b: a is not None and b is not None and permutation.get(b) == a
        # CUE_RULE: one subtitle cue is one line of one speaker, so a cue whose
        # agreed labels change inside it is wrong in both pipelines; the whole cue
        # is excluded. Fixed 27 Oct before this rerun (root decision F4 (a)).
        labels = {}
        for _, a, b, cue in pairs:
            if agree(a, b): labels.setdefault(cue, set()).add(a)
        split = sorted(cue for cue, found in labels.items() if len(found) > 1)
        intervals = []
        for t, a, b, cue in pairs:
            score = agree(a, b) and cue not in split
            reason = None if score else 'consensus label changes inside the cue' if cue in split else 'model disagreement or missing VAD coverage'
            value = {'startMs': float(t), 'endMs': float(t + 10), 'speaker': f'speaker-{a}' if score else None,
                'scorable': score, 'excludedReason': reason}
            if intervals and intervals[-1]['endMs'] == value['startMs'] and all(intervals[-1][k] == value[k] for k in ('speaker', 'scorable', 'excludedReason')):
                intervals[-1]['endMs'] = value['endMs']
            else: intervals.append(value)
        scored = sum(i['endMs'] - i['startMs'] for i in intervals if i['scorable'])
        if scored <= 0: raise RuntimeError('No consensus speech; never substitute silence agreement')
        report = {'version': 1, 'timeUnit': 'ms', 'clip': clip, 'pipelines': [s[0] for s in ARCHITECTURES],
            'labelPermutationOnly': permutation, 'speechGridMs': 10, 'consensusSpeechMs': scored,
            'cueRule': 'A subtitle cue whose agreed consensus labels change inside it is excluded as a whole.',
            'cuesExcludedForLabelChange': split, 'transcriptSha256': hashlib.sha256((STORE / f'datasets/speech/{clip}-aligned.json').read_bytes()).hexdigest(),
            'candidateSpeechMs': len(pairs) * 10, 'nonSpeechExcluded': True, 'intervals': intervals}
        (OUT / (clip + '-consensus.json')).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(clip, 'consensus speech ms', scored, flush=True)

if __name__ == '__main__':
    import sys
    # --acquire: download and licence-check the models only (no OT-2 input needed).
    acquire() if sys.argv[1:] == ['--acquire'] else main()
