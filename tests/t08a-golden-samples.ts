// SPDX-License-Identifier: AGPL-3.0-only
// Authored here: simple, analytically checkable reference images, independent of G-06.
// Probe coordinates are well inside flat fills to avoid antialiasing and font dependence.
export const goldenSamples = [
  {
    name: 'solid background',
    code: `export const Graphic = () => <AbsoluteFill style={{backgroundColor: '#123456'}} />;`,
    probes: [[4, 4, [18, 52, 86, 255]], [60, 60, [18, 52, 86, 255]]],
  },
  {
    name: 'positioned rectangle',
    code: `export const Graphic = () => <AbsoluteFill style={{backgroundColor: '#ffffff'}}><div style={{position: 'absolute', left: 8, top: 12, width: 24, height: 20, backgroundColor: '#ff0000'}} /></AbsoluteFill>;`,
    probes: [[10, 14, [255, 0, 0, 255]], [40, 40, [255, 255, 255, 255]]],
  },
  {
    name: 'layer ordering',
    code: `export const Graphic = () => <AbsoluteFill style={{backgroundColor: '#000000'}}><div style={{position: 'absolute', left: 4, top: 4, width: 40, height: 40, backgroundColor: '#ff0000'}} /><div style={{position: 'absolute', left: 20, top: 20, width: 30, height: 30, backgroundColor: '#0000ff'}} /></AbsoluteFill>;`,
    probes: [[10, 10, [255, 0, 0, 255]], [25, 25, [0, 0, 255, 255]], [60, 60, [0, 0, 0, 255]]],
  },
  {
    name: 'svg fill',
    code: `export const Graphic = () => <AbsoluteFill style={{backgroundColor: '#ffffff'}}><svg width="64" height="64"><rect x="8" y="8" width="32" height="32" fill="#00ff00" /></svg></AbsoluteFill>;`,
    probes: [[12, 12, [0, 255, 0, 255]], [50, 50, [255, 255, 255, 255]]],
  },
  {
    name: 'frame-driven position',
    code: `export const Graphic = () => { const f = useCurrentFrame(); return <AbsoluteFill style={{backgroundColor: '#ffffff'}}><div style={{position: 'absolute', left: f, top: 8, width: 12, height: 12, backgroundColor: '#000000'}} /></AbsoluteFill>; };`,
    probes: [[12, 12, [0, 0, 0, 255]], [35, 12, [255, 255, 255, 255]]],
  },
] as const;
