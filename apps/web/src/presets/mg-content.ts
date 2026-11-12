// SPDX-License-Identifier: AGPL-3.0-only
// Cutframe's own built-in motion-graphic presets (T22; the Motion graphics panel lists them above My Presets). Code written
// for T08's runtime and laid out with itemWidth / itemHeight; boxes on the 1080 × 1920 reference (findings part 2 §31).
import type { GraphicPreset } from '../mg/presets';

const TITLE_WIPE = String.raw`
export const TitleWipe = () => {
  const frame = useCurrentFrame();
  const w = itemWidth, h = itemHeight;
  const title = editable('title', 'Title goes here');
  const color = editable('color', '#ffffff', { type: 'color' });
  const bar = editable('bar', '#ffd23f', { type: 'color' });
  const cover = interpolate(frame, [0, 14, 28], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'relative', padding: h * 0.1, fontSize: Math.min(h * 0.5, w * 0.1), fontWeight: 700, color: color, textAlign: 'center' }}>
        <span style={{ opacity: frame >= 14 ? 1 : 0 }}>{title}</span>
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: frame < 14 ? 0 : 'auto', right: frame < 14 ? 'auto' : 0, width: cover * 100 + '%', backgroundColor: bar }} />
      </div>
    </AbsoluteFill>
  );
};`;

const COUNT_UP = String.raw`
export const CountUp = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const target = editable('target', 1200, { type: 'number' });
  const suffix = editable('suffix', '+');
  const label = editable('label', 'happy customers');
  const color = editable('color', '#ffffff', { type: 'color' });
  const value = interpolate(frame, [0, Math.min(75, durationInFrames * 0.7)], [0, target], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', alignItems: 'center', justifyContent: 'center', color: color }}>
      <div style={{ fontSize: Math.min(h * 0.5, w * 0.24), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{Math.round(value).toLocaleString('en-US')}{suffix}</div>
      <div style={{ fontSize: Math.min(h * 0.14, w * 0.06), opacity: 0.85 }}>{label}</div>
    </AbsoluteFill>
  );
};`;

const BAR_CHART = String.raw`
export const BarChart = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const labels = editable('labels', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  const values = editable('values', ['40', '65', '50', '90', '70']);
  const color = editable('color', '#2f6bff', { type: 'color' });
  const numbers = labels.map((_, n) => Math.max(0, Number(values[n]) || 0));
  const top = Math.max(1, ...numbers);
  const slot = w / labels.length;
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', backgroundColor: '#15171c', borderRadius: w * 0.03 }}>
      {labels.map((label, n) => {
        const grow = spring({ frame: frame - n * 5, fps, config: { damping: 200 } });
        const height = h * 0.66 * numbers[n] / top * grow;
        return (
          <div key={n}>
            <div style={{ position: 'absolute', left: n * slot + slot * 0.2, top: h * 0.8 - height, width: slot * 0.6, height: height, backgroundColor: color, borderRadius: slot * 0.08 }} />
            <div style={{ position: 'absolute', left: n * slot, top: h * 0.84, width: slot, textAlign: 'center', fontSize: h * 0.06, color: '#ffffff' }}>{label}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};`;

const LINE_DRAW = String.raw`
export const LineDraw = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const values = editable('values', ['20', '35', '30', '55', '50', '80']);
  const color = editable('color', '#22b573', { type: 'color' });
  const numbers = values.map(v => Number(v) || 0);
  const low = Math.min(...numbers), high = Math.max(...numbers), range = high - low || 1;
  const points = numbers.map((v, n) => [w * 0.08 + n * w * 0.84 / Math.max(1, numbers.length - 1), h * 0.85 - (v - low) / range * h * 0.7]);
  const d = points.map((p, n) => (n ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  const drawn = interpolate(frame, [0, Math.min(60, durationInFrames * 0.7)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  const last = points[points.length - 1];
  return (
    <AbsoluteFill style={{ backgroundColor: '#15171c', borderRadius: w * 0.03 }}>
      <svg width={w} height={h}>
        <line x1={w * 0.08} y1={h * 0.85} x2={w * 0.92} y2={h * 0.85} stroke="#ffffff" strokeOpacity="0.3" strokeWidth={h * 0.006} />
        <path d={d} fill="none" stroke={color} strokeWidth={h * 0.02} strokeLinecap="round" strokeLinejoin="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - drawn} />
        <circle cx={last[0]} cy={last[1]} r={h * 0.03} fill={color} opacity={drawn >= 1 ? 1 : 0} />
      </svg>
    </AbsoluteFill>
  );
};`;

const ACTION_BUTTON = String.raw`
export const ActionButton = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const label = editable('label', 'Follow for more');
  const color = editable('color', '#ff5a5f', { type: 'color' });
  const enter = spring({ frame, fps, config: { damping: 12 } });
  const pulse = 1 + 0.04 * Math.sin(Math.max(0, frame - 20) / fps * Math.PI * 2);
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: w * 0.9, height: h * 0.7, borderRadius: h, backgroundColor: color, color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: Math.min(h * 0.3, w * 0.08), fontWeight: 700, transform: 'scale(' + enter * pulse + ')' }}>{label}</div>
    </AbsoluteFill>
  );
};`;

const COUNTDOWN = String.raw`
export const Countdown = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const size = Math.min(itemWidth, itemHeight);
  const from = editable('from', 3, { type: 'number', min: 1, max: 9 });
  const color = editable('color', '#ffffff', { type: 'color' });
  const second = Math.floor(frame / fps), within = frame - second * fps;
  const value = from - second;
  const scale = interpolate(within, [0, fps * 0.25], [1.6, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const opacity = interpolate(within, [0, fps * 0.15, fps * 0.8, fps], [0, 1, 1, 0], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', alignItems: 'center', justifyContent: 'center' }}>
      {value > 0 ? <div style={{ fontSize: size * 0.8, lineHeight: 1, fontWeight: 700, color: color, opacity: opacity, transform: 'scale(' + scale + ')' }}>{value}</div> : null}
    </AbsoluteFill>
  );
};`;

const PROGRESS_BAR = String.raw`
export const ProgressBar = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const color = editable('color', '#ffd23f', { type: 'color' });
  const track = editable('track', '#ffffff', { type: 'color' });
  const done = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, backgroundColor: track, opacity: 0.3 }} />
      <div style={{ position: 'absolute', left: 0, top: 0, width: w * done, height: h, backgroundColor: color }} />
    </AbsoluteFill>
  );
};`;

const CHECKLIST = String.raw`
export const Checklist = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const items = editable('items', ['Write the script', 'Record the video', 'Add captions']);
  const color = editable('color', '#22b573', { type: 'color' });
  const row = h / (items.length + 0.5);
  const mark = Math.min(row * 0.6, w * 0.1);
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto', backgroundColor: '#ffffff', borderRadius: w * 0.04 }}>
      {items.map((item, n) => {
        const tick = spring({ frame: frame - 10 - n * 15, fps, config: { damping: 12 } });
        return (
          <div key={n} style={{ position: 'absolute', left: w * 0.07, top: row * (n + 0.25), width: w * 0.86, height: row, display: 'flex', alignItems: 'center' }}>
            <div style={{ width: mark, height: mark, borderRadius: mark * 0.25, border: mark * 0.08 + 'px solid ' + color, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width={mark * 0.7} height={mark * 0.7} viewBox="0 0 24 24" style={{ transform: 'scale(' + tick + ')' }}>
                <path d="M4 12 L10 18 L20 6" fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div style={{ marginLeft: mark * 0.5, fontSize: Math.min(row * 0.36, w * 0.06), color: '#111111' }}>{item}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};`;

const CALLOUT = String.raw`
export const Callout = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const label = editable('label', 'Look here');
  const color = editable('color', '#ffffff', { type: 'color' });
  const dot = spring({ frame, fps, config: { damping: 12 } });
  const line = interpolate(frame, [8, 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const text = interpolate(frame, [18, 28], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const r = h * 0.09;
  return (
    <AbsoluteFill style={{ fontFamily: 'Roboto' }}>
      <svg width={w} height={h} style={{ position: 'absolute' }}>
        <circle cx={r * 1.5} cy={h - r * 1.5} r={r * dot} fill={color} />
        <path d={'M' + r * 1.5 + ' ' + (h - r * 1.5) + ' L' + w * 0.3 + ' ' + h * 0.38 + ' L' + w * 0.95 + ' ' + h * 0.38} fill="none" stroke={color} strokeWidth={h * 0.02} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - line} />
      </svg>
      <div style={{ position: 'absolute', left: w * 0.3, top: 0, width: w * 0.65, height: h * 0.34, display: 'flex', alignItems: 'flex-end', fontSize: Math.min(h * 0.24, w * 0.09), fontWeight: 700, color: color, opacity: text }}>{label}</div>
    </AbsoluteFill>
  );
};`;

const STAR_RATING = String.raw`
export const StarRating = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const w = itemWidth, h = itemHeight;
  const rating = editable('rating', 5, { type: 'number', min: 0, max: 5 });
  const color = editable('color', '#ffd23f', { type: 'color' });
  const size = Math.min(w / 5.6, h * 0.9);
  const star = 'M12 2 L15 9 L22.5 9.6 L16.8 14.4 L18.6 21.8 L12 17.8 L5.4 21.8 L7.2 14.4 L1.5 9.6 L9 9 Z';
  return (
    <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
      {[0, 1, 2, 3, 4].map(n => {
        const pop = spring({ frame: frame - n * 6, fps, config: { damping: 10 } });
        return (
          <svg key={n} width={size} height={size} viewBox="0 0 24 24" style={{ margin: size * 0.05, transform: 'scale(' + pop + ')' }}>
            <path d={star} fill={n < Math.round(rating) ? color : 'none'} stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        );
      })}
    </AbsoluteFill>
  );
};`;

export const BUILT_IN_MG_PRESETS: GraphicPreset[] = [
  { id: 'mg/title-wipe', name: 'Title Wipe', category: 'Titles', mg_code: TITLE_WIPE, spatial: { x: 90, y: 760, width: 900, height: 400 }, duration_ms: 4000 },
  { id: 'mg/count-up', name: 'Count Up', category: 'Numbers', mg_code: COUNT_UP, spatial: { x: 140, y: 760, width: 800, height: 400 }, duration_ms: 4000 },
  { id: 'mg/bar-chart', name: 'Bar Chart', category: 'Charts', mg_code: BAR_CHART, spatial: { x: 90, y: 610, width: 900, height: 700 }, duration_ms: 5000 },
  { id: 'mg/line-draw', name: 'Line Draw', category: 'Charts', mg_code: LINE_DRAW, spatial: { x: 90, y: 660, width: 900, height: 600 }, duration_ms: 5000 },
  { id: 'mg/action-button', name: 'Action Button', category: 'Calls to action', mg_code: ACTION_BUTTON, spatial: { x: 190, y: 1500, width: 700, height: 200 }, duration_ms: 4000 },
  { id: 'mg/countdown', name: 'Countdown', category: 'Numbers', mg_code: COUNTDOWN, spatial: { x: 240, y: 660, width: 600, height: 600 }, duration_ms: 3000 },
  { id: 'mg/progress-bar', name: 'Progress Bar', category: 'Numbers', mg_code: PROGRESS_BAR, spatial: { x: 0, y: 1890, width: 1080, height: 30 }, duration_ms: 10000 },
  { id: 'mg/checklist', name: 'Checklist', category: 'Lists', mg_code: CHECKLIST, spatial: { x: 140, y: 660, width: 800, height: 600 }, duration_ms: 5000 },
  { id: 'mg/callout', name: 'Callout', category: 'Labels', mg_code: CALLOUT, spatial: { x: 240, y: 760, width: 600, height: 300 }, duration_ms: 4000 },
  { id: 'mg/star-rating', name: 'Star Rating', category: 'Labels', mg_code: STAR_RATING, spatial: { x: 190, y: 860, width: 700, height: 200 }, duration_ms: 3000 },
];
