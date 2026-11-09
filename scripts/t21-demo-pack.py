# SPDX-License-Identifier: AGPL-3.0-only
"""FX-3 "First Edit" demo pack reproducer.

Rebuilds vendor/demo-pack/ (video clips, music excerpts and pack.json) from the
downloaded CC0 sources. Every source is a Wikimedia Commons or OpenGameArt file
whose own page states CC0-1.0; the per-file page URL and author are recorded in
pack.json and vendor/manifest.json.

Usage:
    python -I scripts/t21-demo-pack.py <source-dir> [--out <vendor/demo-pack>]

<source-dir> holds one sub-directory per source (see SOURCES below), each with a
single `source.<ext>` download. ffmpeg 8.x / ffprobe must be on PATH. Python needs
only numpy (no scipy / librosa). The script re-encodes every clip, so the sha256
and byte counts it writes into pack.json are exactly what lands on disk.

Analysis (audio): a spectral-flux onset envelope, tempo by autocorrelation, and a
comb-filter beat grid whose period and phase are co-optimised against the envelope.
It is verified not by listening but by measuring each grid beat's distance to the
nearest strong onset; the mean offset is reported and must stay small (< 40 ms).
"""
import argparse, hashlib, json, subprocess, sys
from pathlib import Path
import numpy as np

# --- encode settings -------------------------------------------------------
W, H, FPS = 1280, 720, 30            # every clip: 1280x720, 30 fps, no audio
VP9 = ['-c:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0', '-pix_fmt', 'yuv420p',
       '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-an']
MP3 = ['-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2']  # 128 kbps, accepted by apps/web/src/media/files.ts

# --- analysis settings -----------------------------------------------------
SR, N, HOP = 22050, 1024, 256
STRONG = 0.22          # an onset counts as "strong" at >= this fraction of the peak envelope
TEMPO_LO, TEMPO_HI = 90.0, 190.0

# --- sources ---------------------------------------------------------------
# Each clip: output name -> source sub-dir, provenance, and the ffmpeg recipe
# (input seek `ss`, input trim `t`, and the `-vf` filtergraph). A leading `scale`
# then `crop` reaches 1280x720 without stretching; `setpts=2.0*PTS` makes slow-mo.
VIDEOS = [
    # scenic pool (names carry mountain/aerial/looking/...)
    dict(name='aerial-mount-hood.webm', src='mthood', ss=0.3, t=6.0,
         vf='crop=1184:666,scale=1280:720,fps=30',
         author='Pastelitodepapa', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:Mt_Hood_Aerial_View.webm',
         modified='centre-cropped to 16:9, scaled to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    dict(name='mountain-feathertop.webm', src='federation', ss=0.15, t=5.0,
         vf='scale=1280:720,fps=30',
         author='Bracteantha', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:Federation_Hut_near_Mt_Feathertop.webm',
         modified='trimmed to a 5 s window, scaled to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    dict(name='aerial-frozen-falls.webm', src='drone-ice', ss=46.0, t=6.0,
         vf='scale=-2:720,crop=1280:720,fps=30',
         author='Thomas Tapp', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:Drone_Footage_of_People_Climbing_Ice_Formation.webm',
         modified='trimmed to a 6 s window, scaled and centre-cropped to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    dict(name='aerial-fjord-sunrise.webm', src='drone-ice', ss=93.0, t=6.0,
         vf='scale=-2:720,crop=1280:720,fps=30',
         author='Thomas Tapp', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:Drone_Footage_of_People_Climbing_Ice_Formation.webm',
         modified='trimmed to a 6 s window, scaled and centre-cropped to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    # action pool (names carry none of the scenic words and no "slowmo")
    dict(name='atv-dry-lake.webm', src='atv-races', ss=8.0, t=6.0,
         vf='scale=1280:720,fps=30',
         author='Thomas Farley', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:An_ATV_Rider_Races_Across_the_Jean_Dry_Lake_Bed.webm',
         modified='trimmed to a title-card-free 6 s window, scaled to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    dict(name='atv-trail.webm', src='atv-traffic', ss=7.5, t=6.0,
         vf='scale=1280:720,fps=30',
         author='Thomas Farley', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:ATV_traffic_coming_from_Jean_Lake.webm',
         modified='trimmed to a title-card-free 6 s window, scaled to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    dict(name='desert-quad-run.webm', src='atv-traffic', ss=16.5, t=6.0,
         vf='scale=1280:720,fps=30',
         author='Thomas Farley', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:ATV_traffic_coming_from_Jean_Lake.webm',
         modified='trimmed to a second title-card-free 6 s window, scaled to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    dict(name='dune-quad-bikes.webm', src='dune-quads', ss=42.0, t=6.0,
         vf='scale=1280:720,fps=30',
         author='The Aerial Project', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:Aerial_view_of_quad_bikes_in_sand_dunes.webm',
         modified='trimmed to a 6 s window, scaled to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    dict(name='paraglide-savoie.webm', src='parapente', ss=5.0, t=6.0,
         vf='scale=1280:720,fps=30',
         author='Nicolas Vigier', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:Vol_en_parapente.webm',
         modified='scaled up from 960x540 to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    # slow-motion pool (names carry "slowmo"): an action shot slowed to 50 %
    dict(name='slowmo-dust-rider.webm', src='atv-races', ss=18.0, t=3.0,
         vf='scale=1280:720,setpts=2.0*PTS,fps=30',
         author='Thomas Farley', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:An_ATV_Rider_Races_Across_the_Jean_Dry_Lake_Bed.webm',
         modified='3 s window slowed to 50 % (ffmpeg setpts), scaled to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    dict(name='slowmo-dune-drift.webm', src='dune-quads', ss=62.0, t=3.0,
         vf='scale=1280:720,setpts=2.0*PTS,fps=30',
         author='The Aerial Project', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:Aerial_view_of_quad_bikes_in_sand_dunes.webm',
         modified='3 s window slowed to 50 % (ffmpeg setpts), scaled to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
    dict(name='slowmo-glide.webm', src='parapente', ss=24.0, t=3.0,
         vf='scale=1280:720,setpts=2.0*PTS,fps=30',
         author='Nicolas Vigier', licence='CC0-1.0',
         page='https://commons.wikimedia.org/wiki/File:Vol_en_parapente.webm',
         modified='3 s window slowed to 50 % (ffmpeg setpts), scaled up from 960x540 to 1280x720, 30 fps, re-encoded to VP9 (no audio)'),
]
AUDIOS = [
    dict(name='fever-temple.mp3', src='music-temple', ss=12.0, t=26.0, shape='fever',
         author='Tricks & Traps (OpenGameArt user tricksntraps)', licence='CC0-1.0',
         page='https://opengameart.org/content/free-rhythm-game-music-pack-1',
         title='Flying Temple', modified='excerpt 12.0-38.0 s, encoded to MP3 128 kbps'),
    dict(name='dancefloor-pulse.mp3', src='music-dancefloor', ss=8.5, t=18.0, shape='other',
         author='Umplix', licence='CC0-1.0',
         page='https://opengameart.org/content/dance-music-pack',
         title='Silent Dance Floor', modified='excerpt 8.5-26.5 s, encoded to MP3 128 kbps'),
]


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def source_file(src_dir: Path, sub: str) -> Path:
    hits = sorted(src_dir.joinpath(sub).glob('source.*'))
    if not hits:
        sys.exit(f'missing source: {src_dir / sub}/source.*')
    return hits[0]


def ffprobe_duration(path: Path) -> float:
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                          '-of', 'default=nw=1:nk=1', str(path)],
                         check=True, stdout=subprocess.PIPE, text=True).stdout
    return float(out.strip())


def sha_bytes(path: Path):
    data = path.read_bytes()
    return hashlib.sha256(data).hexdigest(), len(data)


# --- audio analysis (numpy only) ------------------------------------------
def decode(path: Path, start: float, dur: float) -> np.ndarray:
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{start:.4f}', '-t', f'{dur:.4f}',
                          '-i', str(path), '-vn', '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         check=True, stdout=subprocess.PIPE).stdout
    return np.frombuffer(raw, dtype='<f4').astype(np.float64)


def onset_envelope(x: np.ndarray):
    """Half-wave-rectified spectral flux over log-magnitude STFT frames."""
    w = np.hanning(N)
    frames = 1 + max(0, (len(x) - N) // HOP)
    idx = np.arange(N)[None, :] + HOP * np.arange(frames)[:, None]
    mag = np.abs(np.fft.rfft(x[idx] * w, axis=1))
    logmag = np.log1p(100.0 * mag)
    flux = np.maximum(np.diff(logmag, axis=0), 0.0).sum(axis=1)
    env = np.concatenate([[0.0], flux])
    return env, np.arange(len(env)) * HOP / SR


def pick_onsets(env, t, pre=3, post=3, wmean=30, delta=0.08):
    e = env / (env.max() or 1.0)
    out = []
    for i in range(pre, len(e) - post):
        if e[i] <= 0 or e[i] < e[i - pre:i + post + 1].max():
            continue
        lo, hi = max(0, i - wmean), min(len(e), i + wmean + 1)
        if e[i] < e[lo:hi].mean() + delta:
            continue
        a, b, c = e[i - 1], e[i], e[i + 1]
        den = a - 2 * b + c
        frac = float(np.clip(0.5 * (a - c) / den, -0.5, 0.5)) if den != 0 else 0.0
        out.append((t[i] + frac * HOP / SR, float(min(1.0, b))))
    return out


def autocorr_tempo(env):
    e = env - env.mean()
    ac = np.correlate(e, e, 'full')[len(e) - 1:]
    best = (-1.0, 120.0)
    for bpm in np.arange(TEMPO_LO, TEMPO_HI + 0.01, 0.05):
        i = (60.0 / bpm) * SR / HOP
        i0 = int(np.floor(i))
        if i0 + 1 >= len(ac):
            continue
        v = ac[i0] * (1 - (i - i0)) + ac[i0 + 1] * (i - i0)
        if v > best[0]:
            best = (v, bpm)
    return best[1]


def beat_grid(env, span, bpm0):
    """Comb-filter grid: co-optimise period and phase against the envelope."""
    e = env / (env.max() or 1.0)
    base = 60.0 / bpm0
    best = (-1.0, base, 0.0)
    for period in base * np.linspace(0.97, 1.03, 121):
        for ph in np.arange(0, period, 0.002):
            times = np.arange(ph, span, period)
            idx = np.clip((times * SR / HOP).round().astype(int), 0, len(e) - 1)
            score = e[idx].sum() / len(times)
            if score > best[0]:
                best = (score, period, ph)
    _, period, ph = best
    return np.arange(ph, span, period), 60.0 / period


def grid_strengths(grid, env):
    e = env / (env.max() or 1.0)
    idx = np.clip((grid * SR / HOP).round().astype(int), 0, len(e) - 1)
    return np.minimum(1.0, e[idx])


def rms(x, a, b):
    i, j = int(a * SR), int(b * SR)
    seg = x[max(0, i):min(len(x), j)]
    return float(np.sqrt((seg ** 2).mean())) if len(seg) else 0.0


def mean_offset_ms(grid, onsets):
    strong = np.array([o[0] for o in onsets if o[1] >= STRONG])
    if not len(strong):
        return float('nan')
    d = np.abs(grid[:, None] - strong[None, :]).min(axis=1)
    return float(d.mean() * 1000.0)


def pair(t, s):
    return [round(float(t), 3), round(float(s), 3)]


def analyse(path: Path, dur: float, shape: str, report):
    x = decode(path, 0.0, dur + 0.5)
    span = len(x) / SR
    env, t = onset_envelope(x)
    onsets = sorted(pick_onsets(env, t), key=lambda o: o[0])
    bpm0 = autocorr_tempo(env)
    grid, grid_bpm = beat_grid(env, span, bpm0)
    strengths = grid_strengths(grid, env)
    off = mean_offset_ms(grid, onsets)

    beats = [pair(bt, st) for bt, st in zip(grid, strengths)]
    onset_pairs = [pair(ot, os) for ot, os in onsets]
    report[path.name] = dict(bpm=grid_bpm, beats21=int((grid < 21.0).sum()),
                             first=float(grid[0]), offset_ms=off,
                             n_onsets=len(onsets))

    if shape == 'fever':
        rhythm = {'bpm': int(round(grid_bpm)), 'beats': beats, 'onsets': onset_pairs, 'tempoType': 'constant'}
        # locate the drop: the strongest short-term energy rise near 8-10 s
        best = (-1.0, 8.0)
        for T in np.arange(6.5, 11.0, 0.05):
            r = rms(x, T, T + 2) / (rms(x, T - 2, T) + 1e-9)
            if r > best[0]:
                best = (r, float(T))
        drop = round(best[1], 2)
        end = round(min(drop + 8.4, span - 0.01), 2)
        before, after = rms(x, drop - 4, drop), rms(x, drop, drop + 4)
        report[path.name].update(drop=drop, rms_before=before, rms_after=after)
        segments = [{'start_time': drop, 'end_time': end, 'label': 'drop',
                     'description': 'The beat drops: full kick and bass enter after the intro.'}]
        return rhythm, segments
    # "other" track: deliberately only pulseBeats / averageBpm, and no segments
    rhythm = {'averageBpm': int(round(grid_bpm)), 'pulseBeats': beats, 'onsets': onset_pairs, 'tempoType': 'constant'}
    return rhythm, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source_dir', type=Path, help='directory of per-source sub-dirs holding source.<ext>')
    ap.add_argument('--out', type=Path, default=Path(__file__).resolve().parent.parent / 'vendor' / 'demo-pack')
    args = ap.parse_args()
    src_dir, out = args.source_dir, args.out
    out.mkdir(parents=True, exist_ok=True)

    files, report = [], {}

    for v in VIDEOS:
        inp = source_file(src_dir, v['src'])
        dst = out / v['name']
        run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f"{v['ss']}", '-t', f"{v['t']}",
             '-i', str(inp), '-vf', v['vf'], *VP9, str(dst)])
        dur = ffprobe_duration(dst)
        sha, nbytes = sha_bytes(dst)
        files.append({'file': v['name'], 'type': 'video', 'sha256': sha, 'bytes': nbytes,
                      'durationMs': int(round(dur * 1000)), 'licence': v['licence'],
                      'author': v['author'], 'pageUrl': v['page'], 'modified': v['modified']})
        print(f"video  {v['name']:<26} {dur:5.2f}s  {nbytes/1024:6.1f} KiB")

    for a in AUDIOS:
        inp = source_file(src_dir, a['src'])
        dst = out / a['name']
        run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', f"{a['ss']}", '-t', f"{a['t']}",
             '-i', str(inp), '-map', '0:a', *MP3, str(dst)])
        dur = ffprobe_duration(dst)
        sha, nbytes = sha_bytes(dst)
        rhythm, segments = analyse(dst, dur, a['shape'], report)
        rec = {'file': a['name'], 'type': 'audio', 'sha256': sha, 'bytes': nbytes,
               'durationMs': int(round(dur * 1000)), 'licence': a['licence'],
               'author': a['author'], 'pageUrl': a['page'], 'modified': a['modified'],
               'rhythm_data': rhythm}
        if segments is not None:
            rec['segments'] = segments
        files.append(rec)
        r = report[dst.name]
        extra = f" drop@{r['drop']}s rms {r['rms_before']:.3f}->{r['rms_after']:.3f}" if 'drop' in r else ''
        print(f"audio  {a['name']:<26} {dur:5.2f}s  {nbytes/1024:6.1f} KiB  "
              f"bpm {r['bpm']:.2f} beats/21s {r['beats21']} first {r['first']*1000:.0f}ms "
              f"offset {r['offset_ms']:.1f}ms{extra}")

    pack = {'version': 1, 'title': 'First Edit', 'files': files}
    (out / 'pack.json').write_text(json.dumps(pack, indent=2) + '\n', encoding='utf8')
    total = sum(f['bytes'] for f in files)
    print(f"\npack.json written: {len(files)} files, {total/1024/1024:.2f} MiB total")


if __name__ == '__main__':
    main()
