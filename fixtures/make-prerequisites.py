# SPDX-License-Identifier: AGPL-3.0-only
"""Generate T00-owned open fixtures; no editor implementation or private inputs.

All times in project JSON are milliseconds. NPZ arrays retain exact uint8 alpha
and composite pixels independently of any video decoder or future renderer.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import wave
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
STORE = Path(os.environ['CUTFRAME_FIXTURES'])
OUT = Path(os.environ.get('CUTFRAME_PREREQUISITES_OUT', STORE / 'prerequisites'))
OUT.mkdir(parents=True, exist_ok=True)

def json_file(name, data):
    (OUT / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

def video(name, frames, fps=30):
    height, width = frames.shape[1:3]
    command = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo',
               '-pix_fmt', 'rgb24', '-s', f'{width}x{height}', '-r', str(fps), '-i', 'pipe:0',
               '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgr0', '-fflags', '+bitexact',
               '-flags:v', '+bitexact', '-map_metadata', '-1', str(OUT / name)]
    subprocess.run(command, input=frames.tobytes(), check=True)

def alpha_fixtures():
    width, height, count = 160, 96, 60
    background = subprocess.check_output(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', '12',
        '-i', str(STORE / 'corpus/tos-action-30s.mp4'), '-an', '-vf', f'scale={width}:{height},fps=30',
        '-frames:v', str(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    background = np.frombuffer(background, np.uint8).reshape(count, height, width, 3)
    text = np.array(Image.open(STORE / 'synthetic/S3c-text-on-alpha-1080x1920.png').convert('RGBA').resize((54, 96), Image.Resampling.LANCZOS))
    yy, xx = np.mgrid[:height, :width]
    for kind in ('shapes', 'text'):
        colour = np.zeros_like(background)
        alpha = np.zeros((count, height, width), np.uint8)
        for n in range(count):
            if 30 <= n < 36:  # Explicit absence interval for tracking tests.
                continue
            x = 10 + n * 2
            if kind == 'shapes':
                circle = (xx - x) ** 2 + (yy - 38) ** 2 <= 18 ** 2
                bar = (xx >= x - 12) & (xx < x + 24) & (yy >= 58) & (yy < 76)
                alpha[n, circle] = 255
                alpha[n, bar] = 128
                colour[n, circle] = [240, 60, 20]
                colour[n, bar] = [20, 180, 250]
            else:
                left = min(width - 54, n)
                colour[n, :, left:left + 54] = text[:, :, :3]
                alpha[n, :, left:left + 54] = text[:, :, 3]
        # Integer round-half-up definition, with no premultiplication ambiguity.
        a = alpha[..., None].astype(np.uint32)
        composite = ((colour.astype(np.uint32) * a + background.astype(np.uint32) * (255 - a) + 127) // 255).astype(np.uint8)
        np.savez_compressed(OUT / f'OT-4-{kind}-truth.npz', colour=colour, alpha=alpha, background=background, composite=composite)
        video(f'OT-4-{kind}-composite.mkv', composite)
        if kind == 'shapes':
            packed = np.concatenate([colour, np.repeat(alpha[..., None], 3, axis=3)], axis=2)
            video('FX-1-stacked-alpha.mkv', packed)
            np.savez_compressed(OUT / 'FX-1-stacked-alpha-truth.npz', rgba=np.concatenate([colour, alpha[..., None]], axis=3))
    json_file('OT-4-FX-1-description.json', {'version': 1, 'license': 'CC-BY-3.0',
        'attribution': 'Tears of Steel (c) Blender Foundation, mango.blender.org; generated shapes own work, CC0-1.0',
        'fps': 30, 'frames': count, 'size': [width, height], 'source': 'corpus/tos-action-30s.mp4',
        'sourceStartMs': 12000, 'textSource': 'synthetic/S3c-text-on-alpha-1080x1920.png',
        'absentFrameRange': [30, 36], 'rangeConvention': 'half-open',
        'alpha': 'uint8 0..255, straight colour, exact per pixel in NPZ',
        'composite': '(colour*alpha + background*(255-alpha) +127)//255, uint32 intermediate',
        'stackedAlpha': 'left half straight RGB, right half identical R/G/B = alpha; FFV1 lossless bgr0'})

def beat_fixtures():
    rate, duration = 48000, 20
    rng = np.random.default_rng(27002026)
    for label, bpm, meter, noisy in [('click-90', 90, 4, False), ('drum-120', 120, 4, False),
            ('drum-128', 128, 4, False), ('drum-129.2-noise', 129.2, 4, True),
            ('drum-140-3-4', 140, 3, False), ('drum-tempo-change', 100, 4, False)]:
        samples = np.zeros(rate * duration, np.float64)
        beats, t, i = [], 0.5, 0
        while t < duration - 0.25:
            position = int(np.floor(t * rate + 0.5))
            downbeat = i % meter == 0
            beats.append({'sample': position, 'timeMs': position / rate * 1000, 'beatInBar': i % meter + 1, 'downbeat': downbeat})
            length = int(rate * (0.012 if label.startswith('click') else 0.14))
            x = np.arange(length) / rate
            if label.startswith('click'):
                sound = np.cos(2 * np.pi * 2000 * x) * np.exp(-x * 500)
            elif downbeat:
                sound = np.cos(2 * np.pi * (70 * x - 90 * x * x)) * np.exp(-x * 30)
            else:
                sound = rng.uniform(-1, 1, length) * np.exp(-x * 55)
            samples[position:position + length] += 0.65 * sound[:len(samples) - position]
            current_bpm = 140 if label == 'drum-tempo-change' and i >= 16 else bpm
            t += 60 / current_bpm
            i += 1
        if noisy:
            samples += rng.normal(0, 0.025, len(samples))
        pcm = np.floor(np.clip(samples, -1, 1) * 32767 + 0.5).astype('<i2')
        with wave.open(str(OUT / f'OT-5-{label}.wav'), 'wb') as wav:
            wav.setparams((1, 2, rate, len(pcm), 'NONE', 'not compressed'))
            wav.writeframes(pcm.tobytes())
        json_file(f'OT-5-{label}.json', {'version': 1, 'license': 'CC0-1.0', 'sampleRate': rate,
            'durationSamples': len(pcm), 'timeUnit': 'ms', 'meter': [meter, 4], 'bpm': bpm,
            'tempoChanges': [{'beatIndex': 16, 'bpm': 140}] if label == 'drum-tempo-change' else [],
            'beats': beats, 'truth': 'Exact synthesis onset samples, not inferred by a detector'})

def properties(width, height, x=0, y=0, opacity=1):
    return {key: {'defaultValue': value, 'keyframes': []} for key, value in
            dict(width=width, height=height, positionX=x, positionY=y, scale=1, rotation=0, opacity=opacity, volume=1, blendMode='normal').items()}

def project(tracks, items, duration):
    return {'schemaVersion': 4, 'rev': 0, 'duration': duration, 'fps': 30, 'size': {'width': 1920, 'height': 1080},
            'background': {'type': 'color', 'value': '#000000'}, 'tracks': tracks, 'items': items,
            'layerOrder': [{'type': 'track', 'id': t['id']} for t in tracks], 'groups': {}, 'transitions': [], 'markers': []}

def heavy_projects():
    track = {'id': 'video-main', 'kind': 'video', 'name': 'V1', 'muted': False, 'solo': False, 'hidden': False, 'locked': False, 'volume': 1}
    sources = [('corpus/tos-speech-45s.mp4', 45000, 1280, 534), ('corpus/tos-action-30s.mp4', 30000, 1280, 534),
        ('corpus/tos-credits-music-40s.mp4', 40000, 1280, 534),
        ('synthetic/S1-framecount-1080x1920-30fps-10s.mp4', 10000, 1080, 1920),
        ('synthetic/S2-framecount-tone-1920x1080-30fps-10s.mp4', 10000, 1920, 1080)]
    items, at, n = [], 0, 0
    while at < 1800000:
        src, length, width, height = sources[n % len(sources)]
        length = min(length, 1800000 - at)
        props = properties(width, height)
        scale = min(1920 / width, 1080 / height)
        for key, value in dict(scale=scale, positionX=(1920 - width * scale) / 2, positionY=(1080 - height * scale) / 2).items():
            props[key]['defaultValue'] = value
        items.append({'id': f'video-{n}', 'type': 'video', 'trackId': track['id'], 'display': {'from': at, 'to': at + length},
            'trim': {'from': 0, 'to': length}, 'duration': length, 'sourceDuration': sources[n % len(sources)][1],
            'playbackRate': 1, 'details': {'src': f'fixture://{src}'}, 'properties': props, 'metadata': {}, 'effects': [], 'masks': []})
        at += length
        n += 1
    json_file('FX-2-30min-1080p.json', project([track], items, at))
    # Uses only names in the documented injected API. No guessed THREE global,
    # external fetches, Remotion packages or paid packs.
    code = '''// SPDX-License-Identifier: AGPL-3.0-only
export const OrbitingBoxes = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const angle = frame / fps;
  return <ThreeCanvas width={itemWidth} height={itemHeight} camera={{position: [0, 0, 8]}}>
    <ambientLight intensity={0.7} />
    <pointLight position={[5, 5, 5]} intensity={20} />
    {Array.from({length: 64}, (_, i) => <mesh key={i}
      position={[Math.sin(i + angle) * 3, Math.cos(i * 2 + angle) * 2, Math.sin(i * 3) - 2]}
      rotation={[angle + i, angle * 0.7, i]}>
      <boxGeometry args={[0.25, 0.25, 0.25]} />
      <meshStandardMaterial color={i % 2 ? '#42c9f5' : '#f5a642'} />
    </mesh>)}
  </ThreeCanvas>;
};'''
    for number in (1, 5):
        tracks, graphics = [], []
        for n in range(number):
            tid = f'overlay-{n}'
            tracks.append({**track, 'id': tid, 'kind': 'overlay', 'name': f'O{n + 1}'})
            graphics.append({'id': f'graphic-{n}', 'type': 'motionGraphic', 'trackId': tid,
                'display': {'from': 0, 'to': 60000}, 'trim': {'from': 0, 'to': 60000},
                'duration': 60000, 'sourceDuration': 60000, 'playbackRate': 1,
                'details': {'code': code, 'summary': '64 animated lit three.js boxes, frame-driven, designed for 60 seconds',
                    'width': 1920, 'height': 1080, 'durationInFrames': 1800, 'fps': 30},
                'properties': properties(1920, 1080, opacity=1 if n == 0 else 0.5), 'metadata': {}, 'effects': [], 'masks': []})
        json_file(f'FX-2-{number}-threejs-60s.json', project(tracks, graphics, 60000))

def main():
    alpha_fixtures()
    beat_fixtures()
    heavy_projects()
    sibling = ROOT / 'parity-reports/generation/a/S5g-container-bitexact.mkv'
    target = STORE / 'synthetic' / sibling.name
    if sibling.exists():
        if target.exists() and target.read_bytes() != sibling.read_bytes():
            raise RuntimeError('Refusing to overwrite different bitexact sibling')
        if not target.exists():
            shutil.copyfile(sibling, target)
    for file in sorted(OUT.iterdir()):
        if file.is_file():
            print(f'| `prerequisites/{file.name}` | {file.stat().st_size} | `{hashlib.file_digest(file.open("rb"), "sha256").hexdigest()}` |')

if __name__ == '__main__':
    main()
