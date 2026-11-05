# SPDX-License-Identifier: AGPL-3.0-only
"""OT-2: the film's official subtitles, corrected against the audio, force-aligned.

Steps (each writes its evidence to the store; nothing is typed in by hand):
  --download  subtitles, the CTC aligner and the second ASR model
  --decode    per subtitle cue window: wav2vec2 emissions + greedy text, Whisper
              text; a whole-clip scan by both models for speech outside the cues
  --correct   the two-model rule -> datasets/speech-corrections.json (reviewed input)
  --align     CTC forced alignment of the corrected words -> <clip>-aligned.json
Rule: a subtitle word changes only where wav2vec2 AND Whisper agree against it.
Any word the three sources do not all agree on carries textDisputed, whichever
text wins. No editor transcript is used anywhere.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import re
import subprocess
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
STORE = Path(os.environ['CUTFRAME_FIXTURES'])
PUBLIC = STORE / 'datasets/speech'
PUBLIC.mkdir(parents=True, exist_ok=True)
CORRECTIONS = ROOT / 'datasets/speech-corrections.json'
SUBTITLE = 'https://download.blender.org/demo/movies/ToS/subtitles/TOS-en.srt'
# Second, architecture-independent audio check (OpenAI Whisper large-v3-turbo,
# MIT; official sherpa-onnx ONNX export, Apache-2.0 tooling). Evidence only.
WHISPER = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2'
WAV2VEC2 = 'wav2vec2_fairseq_base_ls960_asr_ls960.pth'
# Corpus cut ranges in film seconds (fixture manifest): start, duration.
CLIPS = {'tos-speech-45s': (58.0, 45.0), 'tos-action-30s': (320.0, 30.0)}
# Each cue window = the subtitle's own interval widened by this margin on both
# sides, clipped to the clip and to the midpoint between neighbouring cues.
MARGIN_S = 1.0
# wav2vec2's convolutional front end strides 5·2·2·2·2·2·2 = 320 samples, so
# emission frame k starts at 320k samples = 20k ms of its window (25 ms field).
FRAME_MS = 320 / 16000 * 1000
# A word whose aligned frames have a mean token posterior below this is forced
# against the acoustic model's own belief (music, masking): its text stays in
# the transcript, its times are excluded from timing scores.
MIN_TIMING_CONFIDENCE = 0.25
NORMALISATION = ('Agreement compares keys: case-folded; curly apostrophes become straight; subtitle ellipses are '
    'continuation marks, not words; hyphens split words; every other punctuation mark is dropped; leading and '
    'trailing apostrophes are stripped; integers 0-99 are spelled out in English words; contractions are compared '
    'literally, never expanded.')
COVERAGE_RULE = ('A whole-clip scan window holds possible unsubtitled speech when both models decode the same word '
    '(agreement normalisation, counted with multiplicity) that is not a subtitle word of any cue whose search window '
    'overlaps the scan window. A repeat of a subtitle word is not detected here; the cue-level disputedGaps record those.')

def digest(file):
    return hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()

def download(url, target):
    if not target.exists():
        temp = target.with_suffix(target.suffix + '.part')
        with urllib.request.urlopen(url, timeout=45) as response, temp.open('wb') as out:
            total = 0
            while block := response.read(1024 * 1024):
                out.write(block)
                total += len(block)
                if total % (32 * 1024 * 1024) == 0:
                    print(f'{target.name}: {total} bytes', flush=True)
        temp.replace(target)
    return {'url': url, 'file': target.relative_to(STORE).as_posix(), 'bytes': target.stat().st_size, 'sha256': digest(target)}

def acquire():
    records = [download(SUBTITLE, PUBLIC / 'TOS-en.srt')]
    model_dir = STORE / 'models/torchaudio'
    model_dir.mkdir(parents=True, exist_ok=True)
    records.append(download('https://download.pytorch.org/torchaudio/models/' + WAV2VEC2, model_dir / WAV2VEC2))
    archive = STORE / 'models/asr/sherpa-onnx-whisper-turbo.tar.bz2'
    archive.parent.mkdir(parents=True, exist_ok=True)
    records.append(download(WHISPER, archive))
    import tarfile
    with tarfile.open(archive) as tar: tar.extractall(archive.parent, filter='data')
    (PUBLIC / 'downloads.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(records, indent=2), flush=True)

def cues():
    text = (PUBLIC / 'TOS-en.srt').read_text(encoding='utf-8-sig').replace('\r\n', '\n')
    seconds = lambda s: (lambda h, m, sec, ms: int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000)(*re.split('[:,]', s.strip()))
    result = []
    for block in re.split(r'\n\s*\n', text.strip()):
        lines = block.strip().split('\n')
        start, end = map(seconds, lines[1].split('-->'))
        result.append({'cue': int(lines[0]), 'startS': start, 'endS': end, 'text': ' '.join(l.strip() for l in lines[2:])})
    return result

def cue_windows():
    """Cues that overlap each clip by more than zero time, in clip-local ms."""
    windows = {}
    for clip, (offset, duration) in CLIPS.items():
        inside = [c for c in cues() if c['endS'] > offset and c['startS'] < offset + duration]
        for i, c in enumerate(inside):
            lo, hi = max(0, c['startS'] - offset - MARGIN_S), min(duration, c['endS'] - offset + MARGIN_S)
            if i: lo = max(lo, (inside[i - 1]['endS'] + c['startS']) / 2 - offset)
            if i + 1 < len(inside): hi = min(hi, (c['endS'] + inside[i + 1]['startS']) / 2 - offset)
            c.update(subtitleMs=[round((c['startS'] - offset) * 1000, 3), round((c['endS'] - offset) * 1000, 3)], searchWindowMs=[round(lo * 1000, 3), round(hi * 1000, 3)])
        windows[clip] = inside
    return windows

def audio(clip):
    raw = subprocess.check_output(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(STORE / 'corpus' / (clip + '.mp4')), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
    return np.frombuffer(raw, '<f4').copy()

def greedy_decode(model, labels, samples):
    import torch
    with torch.inference_mode(): emission, _ = model(torch.from_numpy(samples)[None])
    ids = torch.unique_consecutive(emission.argmax(-1)[0]).tolist()
    return emission[0].log_softmax(-1).numpy(), ''.join(labels[i] for i in ids if i != 0).replace('|', ' ').strip()

def whisper_recognizer():
    import sherpa_onnx
    root = STORE / 'models/asr/sherpa-onnx-whisper-turbo'
    # Full precision when the release ships both. Greedy search (= temperature
    # 0), language fixed to English, and no prompt: the subtitle text never
    # reaches the model, so its output is independent evidence.
    pick = lambda part: str(min(root.glob(f'*{part}*.onnx'), key=lambda p: ('int8' in p.name, p.name)))
    recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(encoder=pick('encoder'), decoder=pick('decoder'),
        tokens=str(next(root.glob('*tokens.txt'))), language='en', task='transcribe', decoding_method='greedy_search', num_threads=4)
    def decode(samples):
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, samples)
        recognizer.decode_stream(stream)
        return stream.result.text.strip()
    return decode

def emissions():
    import torch
    import torchaudio
    torch.set_num_threads(4)
    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = bundle.get_model(dl_kwargs={'model_dir': str(STORE / 'models/torchaudio')})
    model.train(False)
    whisper = whisper_recognizer()
    for stale in PUBLIC.glob('*-emission.npy'): stale.unlink()
    checks, coverage = [], []
    for clip, items in cue_windows().items():
        wave = audio(clip)
        for c in items:
            lo, hi = (round(ms * 16) for ms in c['searchWindowMs'])
            samples = wave[lo:hi]
            logp, text = greedy_decode(model, bundle.get_labels(), samples)
            np.save(PUBLIC / f'{clip}-cue{c["cue"]}-emission.npy', logp)
            checks.append({'clip': clip, 'cue': c['cue'], 'subtitleText': c['text'], 'subtitleMs': c['subtitleMs'],
                'searchWindowMs': c['searchWindowMs'], 'sampleOffset': lo, 'sampleCount': len(samples),
                'emissionFrames': len(logp), 'wav2vec2Decode': text, 'whisperDecode': whisper(samples)})
            print(checks[-1], flush=True)
        # Whole-clip scan by both models: speech outside the subtitle cues
        # would be missing from the transcript and must be reviewed.
        for start in range(0, int(len(wave) / 16000), 5):
            samples = wave[start * 16000:(start + 6) * 16000]
            coverage.append({'clip': clip, 'windowMs': [start * 1000, start * 1000 + len(samples) / 16],
                'wav2vec2Decode': greedy_decode(model, bundle.get_labels(), samples)[1], 'whisperDecode': whisper(samples)})
    (PUBLIC / 'audio-checks.json').write_text(json.dumps(checks, indent=2) + '\n', encoding='utf-8')
    (PUBLIC / 'coverage-scan.json').write_text(json.dumps(coverage, indent=2) + '\n', encoding='utf-8')

ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split()

def words(text):
    """[(display, key)] under the fixed NORMALISATION rule."""
    text = text.replace('’', "'").replace('‘', "'").replace('…', ' ').replace('...', ' ')
    result = []
    for part in text.replace('-', ' ').split():
        key = re.sub(r"[^a-z0-9']", '', part.lower()).strip("'")
        if key.isdigit() and int(key) < 100:
            n = int(key)
            spelled = [ONES[n]] if n < 20 else [TENS[n // 10 - 2]] + ([ONES[n % 10]] if n % 10 else [])
            result += [(w, w) for w in spelled]
        elif key: result.append((part, key))
    return result

def alignment(reference, hypothesis):
    """Levenshtein word alignment: per reference index (op, hyp index), and insertions per gap."""
    n, m = len(reference), len(hypothesis)
    d = [[i + j if not i * j else 0 for j in range(m + 1)] for i in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i][j] = min(d[i - 1][j - 1] + (reference[i - 1] != hypothesis[j - 1]), d[i - 1][j] + 1, d[i][j - 1] + 1)
    per_word, inserted, i, j = {}, {}, n, m
    while i or j:
        if i and j and d[i][j] == d[i - 1][j - 1] + (reference[i - 1] != hypothesis[j - 1]):
            per_word[i - 1] = ('match' if reference[i - 1] == hypothesis[j - 1] else 'sub', j - 1); i -= 1; j -= 1
        elif i and d[i][j] == d[i - 1][j] + 1: per_word[i - 1] = ('del', None); i -= 1
        else: inserted.setdefault(i, []).insert(0, j - 1); j -= 1
    return per_word, inserted

def correct():
    checks = json.loads((PUBLIC / 'audio-checks.json').read_text(encoding='utf-8'))
    utterances = []
    for check in checks:
        sub, w2v, whi = words(check['subtitleText']), words(check['wav2vec2Decode']), words(check['whisperDecode'])
        keys = lambda ws: [k for _, k in ws]
        (a, ins_a), (b, ins_b) = alignment(keys(sub), keys(w2v)), alignment(keys(sub), keys(whi))
        # Deletions need both models to have heard speech in the window; two
        # empty decodes mean the speech was masked, not that it is absent.
        heard = bool(w2v) and bool(whi)
        kept, deleted, gaps = [], [], []
        for gap in range(len(sub) + 1):
            extra_a, extra_b = [w2v[j][1] for j in ins_a.get(gap, [])], [whi[j][1] for j in ins_b.get(gap, [])]
            if extra_a and extra_a == extra_b:
                kept += [{'text': whi[j][0], 'key': whi[j][1], 'decision': 'inserted: both ASR', 'textDisputed': True,
                    'subtitle': None, 'wav2vec2': whi[j][1], 'whisper': whi[j][1]} for j in ins_b[gap]]
            elif extra_a or extra_b:
                gaps.append({'beforeWord': len(kept), 'kind': 'one-model insertion', 'wav2vec2': extra_a, 'whisper': extra_b})
            if gap == len(sub): break
            (op_a, j_a), (op_b, j_b) = a[gap], b[gap]
            readings = {'subtitle': sub[gap][1], 'wav2vec2': None if j_a is None else w2v[j_a][1], 'whisper': None if j_b is None else whi[j_b][1]}
            if heard and op_a == op_b == 'del':
                deleted.append({'text': sub[gap][0], 'key': sub[gap][1], 'beforeWord': len(kept), 'decision': 'deleted: both ASR omit it', 'textDisputed': True, **readings})
            elif op_a == op_b == 'sub' and readings['wav2vec2'] == readings['whisper']:
                kept.append({'text': whi[j_b][0], 'key': whi[j_b][1], 'decision': 'substituted: both ASR agree', 'textDisputed': True, **readings})
            else:
                kept.append({'text': sub[gap][0], 'key': sub[gap][1], 'decision': 'subtitle', 'textDisputed': not op_a == op_b == 'match', **readings})
        utterances.append({**{k: check[k] for k in ('clip', 'cue', 'subtitleText', 'subtitleMs', 'searchWindowMs', 'wav2vec2Decode', 'whisperDecode')},
            'correctedText': ' '.join(w['text'] for w in kept), 'words': kept, 'deletedWords': deleted, 'disputedGaps': gaps})
        print(utterances[-1]['cue'], repr(check['subtitleText']), '->', repr(utterances[-1]['correctedText']), flush=True)
    from collections import Counter
    review = []
    for scan in json.loads((PUBLIC / 'coverage-scan.json').read_text(encoding='utf-8')):
        lo, hi = scan['windowMs']
        cued = {k for c in checks if c['clip'] == scan['clip'] and c['searchWindowMs'][0] < hi and c['searchWindowMs'][1] > lo for _, k in words(c['subtitleText'])}
        both = Counter(k for _, k in words(scan['wav2vec2Decode'])) & Counter(k for _, k in words(scan['whisperDecode']))
        extra = sorted(k for k in both.elements() if k not in cued)
        review.append({**scan, 'overlappingCueWords': sorted(cued), 'bothModelWordsOutsideCues': extra,
            'verdict': 'possible unsubtitled speech' if extra else 'no unsubtitled speech'})
    report = {'version': 1, 'rule': __doc__.split('Rule: ')[1].split(' No editor')[0].replace('\n', ' '),
        'normalisation': NORMALISATION, 'cueMarginS': MARGIN_S, 'clips': CLIPS,
        'coverageRule': COVERAGE_RULE, 'coverageReview': review,
        'coverageSha256': digest(PUBLIC / 'coverage-scan.json'),
        'deletionGuard': 'A both-ASR deletion applies only when both models decoded some text in the window.',
        'subtitleSha256': digest(PUBLIC / 'TOS-en.srt'), 'audioChecksSha256': digest(PUBLIC / 'audio-checks.json'),
        'utterances': utterances}
    CORRECTIONS.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')

def ctc_align(logp, tokens):
    """Maximum-likelihood CTC state path with blanks and repeat constraints."""
    states = np.zeros(2 * len(tokens) + 1, dtype=int)
    states[1::2] = tokens
    size = len(states)
    previous = np.full(size, -np.inf, np.float32)
    previous[0] = logp[0, 0]
    if len(tokens): previous[1] = logp[0, tokens[0]]
    back = np.zeros((len(logp), size), np.int8)
    skip = (states != 0) & (states != np.roll(states, 2))
    skip[:2] = False
    for t in range(1, len(logp)):
        advance = np.r_[-np.inf, previous[:-1]]
        jump = np.r_[[-np.inf, -np.inf], previous[:-2]]
        jump[~skip] = -np.inf
        candidates = np.stack([previous, advance, jump])
        choice = candidates.argmax(axis=0)
        back[t] = choice
        previous = candidates[choice, np.arange(size)] + logp[t, states]
    at = size - 1 if previous[-1] > previous[-2] else size - 2
    score = float(previous[at])
    if not np.isfinite(score): raise RuntimeError('Transcript cannot be aligned within the search window')
    path = np.zeros(len(logp), dtype=int)
    for t in range(len(logp) - 1, -1, -1):
        path[t] = at
        at -= int(back[t, at])
    return states, path, score

def align(corrections_file):
    import torchaudio
    labels = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H.get_labels()
    dictionary = {v: i for i, v in enumerate(labels)}
    checks = json.loads((PUBLIC / 'audio-checks.json').read_text(encoding='utf-8'))
    corrections = json.loads(Path(corrections_file).read_text(encoding='utf-8'))
    for clip in CLIPS:
        aligned, utterances = [], []
        for check in [c for c in checks if c['clip'] == clip]:
            entry = next(u for u in corrections['utterances'] if u['clip'] == clip and u['cue'] == check['cue'])
            keys = [w['key'].upper() for w in entry['words']]
            tokens = [dictionary[c] for c in '|'.join(keys)]
            logp = np.load(PUBLIC / f'{clip}-cue{check["cue"]}-emission.npy')
            if len(logp) != (check['sampleCount'] - 400) // 320 + 1: raise RuntimeError('Unexpected emission frame count')
            states, path, score = ctc_align(logp, tokens)
            offset, cursor = check['sampleOffset'] / 16, 0
            for word, key in zip(entry['words'], keys):
                frames = np.flatnonzero(np.isin(path, [2 * i + 1 for i in range(cursor, cursor + len(key))]))
                if not len(frames): raise RuntimeError('CTC failed to align token')
                confidence = float(np.exp(logp[frames, states[path[frames]]]).mean())
                aligned.append({'text': word['text'], 'startMs': round(offset + int(frames[0]) * FRAME_MS, 3),
                    'endMs': round(offset + (int(frames[-1]) + 1) * FRAME_MS, 3), 'cue': check['cue'],
                    'alignmentConfidence': round(confidence, 4), 'timingScorable': confidence >= MIN_TIMING_CONFIDENCE,
                    'textDisputed': word['textDisputed'], 'decision': word['decision']})
                cursor += len(key) + 1
            utterances.append({k: entry[k] for k in ('cue', 'subtitleText', 'correctedText', 'subtitleMs', 'searchWindowMs', 'wav2vec2Decode', 'whisperDecode', 'deletedWords', 'disputedGaps')}
                | {'ctcLogLikelihood': score, 'emissionFrames': len(logp)})
        report = {'version': 1, 'clip': clip, 'timeUnit': 'ms', 'timeBase': 'clip-local (source) time', 'license': 'CC-BY-3.0',
            'attribution': '"Tears of Steel" (c) Blender Foundation, mango.blender.org',
            'subtitleUrl': SUBTITLE, 'subtitleSha256': digest(PUBLIC / 'TOS-en.srt'), 'correctionsSha256': digest(Path(corrections_file)),
            'aligner': 'torchaudio WAV2VEC2_ASR_BASE_960H emissions; own CTC Viterbi blank/repeat trellis (datasets/prepare-speech.py)',
            'frameMs': FRAME_MS, 'minTimingConfidence': MIN_TIMING_CONFIDENCE, 'cueMarginS': MARGIN_S,
            'modelSha256': digest(STORE / 'models/torchaudio' / WAV2VEC2), 'utterances': utterances, 'words': aligned}
        (PUBLIC / f'{clip}-aligned.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print(clip, 'force-aligned words', len(aligned), 'timing-scorable', sum(w['timingScorable'] for w in aligned),
            'text-disputed', sum(w['textDisputed'] for w in aligned), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--decode', action='store_true')
    parser.add_argument('--correct', action='store_true')
    parser.add_argument('--align', metavar='CORRECTIONS_JSON', nargs='?', const=str(CORRECTIONS))
    args = parser.parse_args()
    if args.download: acquire()
    if args.decode: emissions()
    if args.correct: correct()
    if args.align: align(args.align)
