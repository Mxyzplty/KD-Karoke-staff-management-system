// SPDX-License-Identifier: AGPL-3.0-only
// Cutframe's own motion-graphic style presets (T22): code written for T08's runtime (mg/runtime-components.tsx API), laid
// out with itemWidth / itemHeight so one code fits any box. Boxes are on the 1080 × 1920 reference (spatial) or the 1920 ×
// 1080 one (spatial_h); placement is T08's placeGraphicPreset (findings part 2 §31). Roboto is the sandbox's own font.
import type { GraphicStylePreset } from './model';

const SIDE_PANEL = String.raw`
export const SidePanel = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const title = editable('title', 'Key points');
  const points = editable('points', ['First point', 'Second point', 'Third point']);
  const accent = editable('accent', '#2f6bff', { type: 'color' });
  const enter = spring({ frame, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', transform: 'translateX(' + (1 - enter) * w + 'px)' }}>
      <AbsoluteFill style={{ backgroundColor: '#15171c', opacity: 0.94 }} />
      <div style={{ position: 'absolute', left: 0, top: 0, width: w * 0.02, height: h, backgroundColor: accent }} />
      <div style={{ position: 'absolute', left: w * 0.12, top: h * 0.3, width: w * 0.78, color: '#ffffff' }}>
        <div style={{ fontSize: w * 0.11, fontWeight: 700, marginBottom: w * 0.08 }}>{title}</div>
        {points.map((p, n) => {
          const show = interpolate(frame, [12 + n * 8, 24 + n * 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          return <div key={n} style={{ fontSize: w * 0.075, marginBottom: w * 0.05, opacity: show, transform: 'translateX(' + (1 - show) * w * 0.08 + 'px)' }}>{p}</div>;
        })}
      </div>
    </AbsoluteFill>
  );
};`;

const BOTTOM_SHEET = String.raw`
export const BottomSheet = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const heading = editable('heading', 'Worth knowing');
  const body = editable('body', 'One or two lines that add context to what is on screen.');
  const color = editable('color', '#ffffff', { type: 'color' });
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const text = interpolate(frame, [10, 22], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', transform: 'translateY(' + (1 - enter) * h + 'px)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, backgroundColor: color, borderTopLeftRadius: w * 0.05, borderTopRightRadius: w * 0.05 }} />
      <div style={{ position: 'absolute', left: w * 0.44, top: h * 0.05, width: w * 0.12, height: h * 0.015, borderRadius: h, backgroundColor: '#c9ccd3' }} />
      <div style={{ position: 'absolute', left: w * 0.08, top: h * 0.17, width: w * 0.84, color: '#111111', opacity: text }}>
        <div style={{ fontSize: w * 0.065, fontWeight: 700, marginBottom: h * 0.06 }}>{heading}</div>
        <div style={{ fontSize: w * 0.042, lineHeight: 1.35 }}>{body}</div>
      </div>
    </AbsoluteFill>
  );
};`;

const PROGRESS_RING = String.raw`
export const ProgressRing = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const size = Math.min(itemWidth, itemHeight);
  const percent = editable('percent', 75, { type: 'number', min: 0, max: 100 });
  const color = editable('color', '#2f6bff', { type: 'color' });
  const label = editable('label', 'complete');
  const fill = interpolate(frame, [0, Math.min(60, durationInFrames * 0.6)], [0, percent], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const r = 42, length = 2 * Math.PI * r;
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#ffffff" strokeOpacity="0.25" strokeWidth="8" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={length} strokeDashoffset={length * (1 - fill / 100)} transform="rotate(-90 50 50)" />
        <text x="50" y="53" textAnchor="middle" fontSize="22" fontWeight="700" fill="#ffffff">{Math.round(fill)}%</text>
        <text x="50" y="66" textAnchor="middle" fontSize="7" fill="#ffffff">{label}</text>
      </svg>
    </AbsoluteFill>
  );
};`;

const PHOTO_STACK = String.raw`
export const PhotoStack = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const captions = editable('captions', ['One', 'Two', 'Three']);
  const colors = ['#2f6bff', '#ffd23f', '#ff5a5f'];
  const angles = [-9, 5, -3];
  const side = Math.min(w, h) * 0.62;
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto' }}>
      {captions.slice(0, 3).map((caption, n) => {
        const enter = spring({ frame: frame - n * 10, fps, config: { damping: 14 } });
        const x = w / 2 - side / 2 + (n - 1) * side * 0.18, y = h / 2 - side * 0.6 + (n - 1) * side * 0.12;
        return (
          <div key={n} style={{ position: 'absolute', left: x, top: y, width: side, height: side * 1.2, padding: side * 0.05, boxSizing: 'border-box', backgroundColor: '#ffffff', boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)', opacity: Math.min(1, enter), transform: 'scale(' + (0.6 + 0.4 * enter) + ') rotate(' + angles[n] * enter + 'deg)' }}>
            <div style={{ width: '100%', height: '80%', backgroundColor: colors[n] }} />
            <div style={{ height: '20%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: side * 0.08, color: '#111111' }}>{caption}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};`;

const GRID_REVEAL = String.raw`
export const GridReveal = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const labels = editable('labels', ['Morning', 'Midday', 'Evening', 'Night']);
  const colors = ['#2f6bff', '#ffd23f', '#ff5a5f', '#22b573'];
  const gap = Math.min(w, h) * 0.02;
  const tileW = (w - gap * 3) / 2, tileH = (h - gap * 3) / 2;
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', backgroundColor: '#0e0f12' }}>
      {labels.slice(0, 4).map((label, n) => {
        const enter = spring({ frame: frame - n * 6, fps, config: { damping: 200 } });
        const col = n % 2, row = Math.floor(n / 2);
        return (
          <div key={n} style={{ position: 'absolute', left: gap + col * (tileW + gap), top: gap + row * (tileH + gap), width: tileW, height: tileH, overflow: 'hidden', borderRadius: gap }}>
            <div style={{ width: '100%', height: '100%', backgroundColor: colors[n], display: 'flex', alignItems: 'flex-end', transform: 'translateY(' + (1 - enter) * 100 + '%)' }}>
              <div style={{ padding: gap * 2, fontSize: Math.min(tileW, tileH) * 0.11, fontWeight: 700, color: '#111111' }}>{label}</div>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};`;

const FILM_STRIP = String.raw`
export const FilmStrip = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const count = editable('frames', 5, { type: 'number', min: 3, max: 8 });
  const colors = ['#2f6bff', '#ffd23f', '#ff5a5f', '#22b573', '#9b5de5', '#f15bb5', '#00bbf9', '#fee440'];
  const cell = h * 0.72, gap = h * 0.06, total = count * (cell + gap);
  const shift = interpolate(frame, [0, durationInFrames], [w * 0.1, Math.min(w * 0.1, w * 0.9 - total)], { extrapolateRight: 'clamp' });
  const holes = Math.ceil(w / (h * 0.09));
  return (
    <AbsoluteFill style={{ backgroundColor: '#111111' }}>
      {Array.from({ length: holes }, (_, n) => [0.04, 0.9].map(top => (
        <div key={n + '-' + top} style={{ position: 'absolute', left: n * h * 0.09 + h * 0.02, top: h * top, width: h * 0.05, height: h * 0.06, borderRadius: h * 0.01, backgroundColor: '#f2f2f2' }} />
      )))}
      {Array.from({ length: count }, (_, n) => (
        <div key={n} style={{ position: 'absolute', left: shift + n * (cell + gap), top: h * 0.14, width: cell, height: cell, backgroundColor: colors[n % colors.length], borderRadius: h * 0.02 }} />
      ))}
    </AbsoluteFill>
  );
};`;

export const GRAPHIC_STYLE_PRESETS: GraphicStylePreset[] = [
  { id: 'slide-in-panels/side-panel', name: 'Side Panel', duration_ms: 6000,
    description: 'A dark panel that slides in from the right and covers half the frame, with a title and up to three points that appear one by one. On a wide canvas it takes the right third. The title, the points and the accent colour can be edited.',
    mg_code: SIDE_PANEL, spatial: { x: 540, y: 0, width: 540, height: 1920 }, mg_code_h: SIDE_PANEL, spatial_h: { x: 1280, y: 0, width: 640, height: 1080 } },
  { id: 'slide-in-panels/bottom-sheet', name: 'Bottom Sheet', duration_ms: 5000,
    description: 'A light sheet with rounded top corners that rises from the bottom edge and covers the lower third. It holds a heading and a short paragraph. It stays pinned to the bottom on any canvas shape.',
    mg_code: BOTTOM_SHEET, spatial: { x: 0, y: 1280, width: 1080, height: 640 } },
  { id: 'misc/progress-ring', name: 'Progress Ring', duration_ms: 4000,
    description: 'A ring that fills clockwise up to a percentage while the figure in the middle counts up with it, with a small label below. The percentage, the colour and the label can be edited. Use it for goals, scores and survey results.',
    mg_code: PROGRESS_RING, spatial: { x: 290, y: 710, width: 500, height: 500 } },
  { id: 'collages/photo-stack', name: 'Photo Stack',
    duration_ms: 5000,
    description: 'Three instant-photo cards that drop onto the middle of the frame one after another, each tilted a little differently, with a caption under each. The cards are coloured placeholders: ask the assistant to put your own pictures in them.',
    mg_code: PHOTO_STACK },
  { id: 'collages/grid-reveal', name: 'Grid Reveal', duration_ms: 5000,
    description: 'A two by two grid that fills the whole frame. The four tiles slide up into view one after another, each with a label in its bottom left corner. The tiles are coloured placeholders for four pictures or clips.',
    mg_code: GRID_REVEAL },
  { id: 'collages/film-strip', name: 'Film Strip', duration_ms: 6000,
    description: 'A strip of film across the middle of the frame, with sprocket holes along both edges and a row of frames that drifts slowly to the left. The number of frames can be edited. The frames are coloured placeholders.',
    mg_code: FILM_STRIP, spatial: { x: 0, y: 660, width: 1080, height: 600 } },
];
