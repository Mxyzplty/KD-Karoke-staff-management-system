# SPDX-License-Identifier: AGPL-3.0-only
"""T12 oracle fixtures (BG-P01, BG-P03): actors of Tears of Steel with their production alpha over people-free plates of clip 2.

Foregrounds are the cleaned plates of the film (CC BY 3.0, (CC) Blender Foundation | mango.blender.org, logos excluded): 4096 x 2160
float EXR, premultiplied linear RGBA. Each file is fetched, checked against the archive's SHA1SUMS.txt (pinned below) and dropped once read.
Shots, frames and plates were fixed before any matte was scored; see the T12 notes. Written to $CUTFRAME_FIXTURES/datasets/t12/composites/:
  <name>.mp4            the composite, H.264 at the frame size and rate of clip 2
  <name>-alpha.bin.gz   exact alpha, uint8, frames x 534 x 1280, row-major; truth is alpha >= 128
Run with OPENCV_IO_ENABLE_OPENEXR=1 (set below, before cv2 loads).
"""
import gzip, hashlib, http.client, os, re, subprocess, tempfile, time, urllib.request
from pathlib import Path
os.environ['OPENCV_IO_ENABLE_OPENEXR'] = '1'
import cv2
import numpy as np

STORE = Path(os.environ['CUTFRAME_FIXTURES'])
OUT = STORE / 'datasets/t12/composites'
CLIP = STORE / 'corpus/tos-action-30s.mp4'
ARCHIVE = 'https://ftp.lysator.liu.se/pub/xiph/media/tearsofsteel/tearsofsteel-cleaned-exr'
SUMS_SHA256 = '2d3d82534a66d4d5d3682d2cc97a96ae7d6fc2177fbd04795ddf0e8f34baad77'
WIDTH, HEIGHT, FPS, FRAMES = 1280, 534, 24, 72
# Frame numbers of clip 2, each range inside one shot with no person in it (cuts at 8.458, 10.292; the machine enters the roofs at about 12 s).
PLATES = {'skyline': (205, 246), 'roofs': (248, 288)}
# BG-P01: full figure, arms out, crouching, half figure, a group. Rope or prop shots are left out: alpha there is more than the person.
# Name, shot, plate, rows moved down: in 04_3d and 04_3f the production alpha holds the set floor under the feet, which is no person, so it goes out of frame.
BG_P01 = [('bg-p01-standing', '08_4a', 'skyline', 0), ('bg-p01-arms', '04_3d', 'roofs', 26), ('bg-p01-crouching', '09_1a', 'skyline', 0), ('bg-p01-half', '07_1b', 'roofs', 0), ('bg-p01-group', '04_3f', 'skyline', 26)]
# BG-P03: the soldier of 07_2b, scaled to his size in clip 2 at 19 s, behind the balusters of that shot. Scale and crop are in EXR px.
SOLDIER = {'shot': '07_2b', 'scale': 0.53, 'crop': (488, 160)}
# The soldier stands clear of the rope (left of LEFT) and the column (right of a line through RIGHT), EXR px.
LEFT, RIGHT = 1160, ((2780, 0), (2790, 2160))
# Balusters traced by hand on frame 480 of clip 2 (20 s), 1280 x 534: axis x, then half width by height.
BALUSTER_FRAME = 480
BALUSTERS = [(215, [(0, 98), (60, 100), (100, 88), (135, 65), (190, 68), (225, 85), (255, 98), (290, 92), (340, 78), (400, 72), (440, 78), (465, 90), (534, 98)]),
             (925, [(0, 107), (60, 100), (100, 88), (135, 68), (190, 65), (225, 82), (250, 102), (290, 92), (340, 80), (400, 76), (440, 80), (470, 78), (534, 86)])]


def srgb_to_linear(v):
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v):
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.maximum(v, 1e-9) ** (1 / 2.4) - 0.055)


def sums():
    with urllib.request.urlopen(f'{ARCHIVE}/SHA1SUMS.txt') as r:
        data = r.read()
    if hashlib.sha256(data).hexdigest() != SUMS_SHA256:
        raise SystemExit('SHA1SUMS.txt is not the pinned file')
    return {name[2:]: sha for sha, name in (line.split(None, 1) for line in data.decode().splitlines())}


def fetch(url, tries=8):
    """The archive drops long transfers now and then: fetch again after a pause; the hash decides what counts."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except (OSError, http.client.HTTPException):
            if attempt == tries - 1:
                raise
            time.sleep(15 * (attempt + 1))


def exr(table, path):
    data = fetch(f'{ARCHIVE}/{path}')
    if hashlib.sha1(data).hexdigest() != table[path]:
        raise SystemExit(f'{path}: SHA-1 differs')
    with tempfile.TemporaryDirectory() as d:
        name = Path(d) / 'f.exr'
        name.write_bytes(data)
        return cv2.imread(str(name), cv2.IMREAD_UNCHANGED)


def middle(table, shot, count):
    """The middle `count` frames of the shot's longest unbroken run."""
    found = sorted((int(m[1]), p) for p in table if (m := re.fullmatch(rf'{shot}/linear/{shot}_(\d+)\.exr', p)))
    best, run = [], []
    for item in found:
        run = run + [item] if run and item[0] == run[-1][0] + 1 else [item]
        if len(run) > len(best):
            best = run
    start = (len(best) - count) // 2
    return [p for _, p in best[max(start, 0):max(start, 0) + count]]


def plates():
    cap, frames = cv2.VideoCapture(str(CLIP)), {}
    for i in range(max(b for _, b in PLATES.values()) + 1):
        frames[i] = cap.read()[1]
    return {k: [frames[i] for i in range(a, b + 1)] for k, (a, b) in PLATES.items()}


def bounce(i, n):
    """Plate index for composite frame i: forwards and back, so a short shot has no cut."""
    i %= 2 * n - 2
    return i if i < n else 2 * n - 2 - i


class Encoder:
    def __init__(self, path):
        self.p = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{WIDTH}x{HEIGHT}', '-r', str(FPS), '-i', '-',
                                   '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-threads', '1',
                                   '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', str(path)], stdin=subprocess.PIPE)

    def write(self, frame):
        self.p.stdin.write(frame.tobytes())

    def close(self):
        self.p.stdin.close()
        if self.p.wait():
            raise SystemExit('ffmpeg failed')


def over(premultiplied, alpha, plate):
    """Linear light: foreground over the plate, back to 8-bit sRGB (BGR)."""
    out = np.clip(premultiplied + (1 - alpha[..., None]) * srgb_to_linear(plate / 255), 0, 1)
    return (linear_to_srgb(out) * 255 + 0.5).astype(np.uint8)


def write(name, frames, alphas):
    video = Encoder(OUT / f'{name}.mp4')
    for f in frames:
        video.write(f)
    video.close()
    (OUT / f'{name}-alpha.bin.gz').write_bytes(gzip.compress(np.stack(alphas).tobytes(), 9, mtime=0))


def composite(table, name, shot, plate, drop):
    width, x = 1013, (WIDTH - 1013) // 2
    frames, alphas = [], []
    for i, path in enumerate(middle(table, shot, FRAMES)):
        m = np.roll(cv2.resize(exr(table, path), (width, HEIGHT), interpolation=cv2.INTER_AREA), drop, axis=0)
        m[:drop] = 0
        fg, alpha = np.zeros((HEIGHT, WIDTH, 3), np.float32), np.zeros((HEIGHT, WIDTH), np.float32)
        fg[:, x:x + width], alpha[:, x:x + width] = m[..., :3], np.clip(m[..., 3], 0, 1)
        frames.append(over(np.maximum(fg, 0), alpha, plate[bounce(i, len(plate))]))
        alphas.append((alpha * 255 + 0.5).astype(np.uint8))
    write(name, frames, alphas)
    print(name, shot, f'area {np.mean([(a >= 128).mean() for a in alphas]):.4f}', flush=True)


def baluster_alpha():
    size = (HEIGHT * 4, WIDTH * 4)
    mask = np.zeros(size, np.uint8)
    for axis, profile in BALUSTERS:
        ys = np.array([y for y, _ in profile], float)
        half = np.array([h for _, h in profile], float)
        rows = np.arange(0, HEIGHT, 0.25)
        widths = np.interp(rows, ys, half)
        pts = np.concatenate([np.stack([axis - widths, rows], 1), np.stack([axis + widths, rows], 1)[::-1]])
        cv2.fillPoly(mask, [(pts * 4).astype(np.int32)], 255)
    # The balusters are out of focus: a soft edge as in the shot.
    return cv2.GaussianBlur(cv2.resize(mask, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA), (0, 0), 4).astype(np.float32) / 255


def behind_balusters(table, plate):
    cap = cv2.VideoCapture(str(CLIP))
    cap.set(cv2.CAP_PROP_POS_FRAMES, BALUSTER_FRAME)
    shot = cap.read()[1]
    guard = baluster_alpha()
    back = cv2.GaussianBlur(plate[0], (0, 0), 12)
    x0, y0 = SOLDIER['crop']
    frames, alphas = [], []
    for path in middle(table, SOLDIER['shot'], 47):
        m = exr(table, path)
        h, w = m.shape[:2]
        lane = np.zeros((h, w), np.float32)
        (xa, ya), (xb, yb) = RIGHT
        for y in range(h):
            lane[y, LEFT:int(xa + (xb - xa) * (y - ya) / (yb - ya))] = 1
        m[..., :4] *= lane[..., None]
        scaled = cv2.resize(m, None, fx=SOLDIER['scale'], fy=SOLDIER['scale'], interpolation=cv2.INTER_AREA)[y0:y0 + HEIGHT, x0:x0 + WIDTH]
        soldier = np.clip(scaled[..., 3], 0, 1)
        person = over(np.maximum(scaled[..., :3], 0), soldier, back)
        frames.append((person * (1 - guard[..., None]) + shot * guard[..., None] + 0.5).astype(np.uint8))
        alphas.append((soldier * (1 - guard) * 255 + 0.5).astype(np.uint8))
    write('bg-p03-balusters', frames, alphas)
    print('bg-p03-balusters', f'area {np.mean([(a >= 128).mean() for a in alphas]):.4f}', flush=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    table, back = sums(), plates()
    made = lambda name: (OUT / f'{name}.mp4').exists() and (OUT / f'{name}-alpha.bin.gz').exists()
    for name, shot, plate, drop in BG_P01:
        if not made(name):
            composite(table, name, shot, back[plate], drop)
    if not made('bg-p03-balusters'):
        behind_balusters(table, back['skyline'])
    for f in sorted(OUT.iterdir()):
        print(f.name, f.stat().st_size, hashlib.sha256(f.read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
