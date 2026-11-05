// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';

test('runtime exposes the complete documented motion-graphic surface', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const missing = await page.evaluate(async () => {
    const path = '/src/mg/runtime.ts';
    const { createRuntime } = await import(/* @vite-ignore */ path);
    const runtime = createRuntime({});
    const names = ['React', 'useState', 'useEffect', 'useMemo', 'useRef', 'useCallback',
      'AbsoluteFill', 'interpolate', 'interpolateColors', 'useCurrentFrame', 'useVideoConfig', 'spring', 'Easing', 'Sequence', 'Img', 'OffthreadVideo',
      'Rect', 'Circle', 'Triangle', 'Star', 'Polygon', 'Ellipse', 'Heart', 'Pie',
      'makeRect', 'makeCircle', 'makeTriangle', 'makeStar', 'makePolygon', 'makeEllipse', 'makeHeart', 'makePie',
      'evolvePath', 'interpolatePath', 'noise3D', 'TransitionSeries', 'linearTiming', 'springTiming', 'fade', 'slide', 'wipe',
      'Lottie', 'ThreeCanvas', 'getAssetUrl', 'itemWidth', 'itemHeight', 'editable'];
    return names.filter(name => !(name in runtime) || runtime[name] == null);
  });
  expect(missing).toEqual([]);
});

test('interpolation modes, shape bounds, editable values and seeded noise follow the contract', async ({ page }) => {
  await page.goto('/src/mg/harness.html');
  const values = await page.evaluate(async () => {
    const path = '/src/mg/runtime.ts';
    const { createRuntime } = await import(/* @vite-ignore */ path);
    const r = createRuntime({ width: 320, height: 180, fieldValues: { title: 'changed', enabled: false } });
    const i = r.interpolate;
    const rect = r.makeRect({ width: 40, height: 20 });
    const circle = r.makeCircle({ radius: 10 });
    const ellipse = r.makeEllipse({ rx: 12, ry: 8 });
    const triangles = ['up', 'right', 'down', 'left'].map(direction => r.makeTriangle({ length: 20, direction }));
    return {
      interpolation: [i(5, [0, 10], [0, 100]), i(-5, [0, 10], [0, 100]),
        i(-5, [0, 10], [0, 100], { extrapolateLeft: 'clamp' }),
        i(15, [0, 10], [0, 100], { extrapolateRight: 'clamp' }),
        i(-5, [0, 10], [0, 100], { extrapolateLeft: 'identity' }),
        i(15, [0, 10], [0, 100], { extrapolateRight: 'wrap' })],
      sizes: [rect, circle, ellipse, ...triangles].map(s => [s.width, s.height]),
      paths: [rect, circle, ellipse, ...triangles].map(s => typeof s.path),
      editable: [r.editable('title', 'default'), r.editable('enabled', true), r.editable('missing', 42)],
      size: [r.itemWidth, r.itemHeight],
      noise: [r.noise3D('seed', 1, 2, 3), r.noise3D('seed', 1, 2, 3)],
    };
  });
  expect(values.interpolation).toEqual([50, -50, 0, 100, -5, 50]);
  expect(values.sizes.slice(0, 3)).toEqual([[40, 20], [20, 20], [24, 16]]);
  expect(values.sizes[3][0]).toBeCloseTo(20); expect(values.sizes[3][1]).toBeCloseTo(10 * Math.sqrt(3));
  expect(values.sizes[4][0]).toBeCloseTo(10 * Math.sqrt(3)); expect(values.sizes[4][1]).toBeCloseTo(20);
  expect(values.sizes[5][0]).toBeCloseTo(20); expect(values.sizes[5][1]).toBeCloseTo(10 * Math.sqrt(3));
  expect(values.sizes[6][0]).toBeCloseTo(10 * Math.sqrt(3)); expect(values.sizes[6][1]).toBeCloseTo(20);
  expect(values.paths).toEqual(Array(7).fill('string'));
  expect(values.editable).toEqual(['changed', false, 42]);
  expect(values.size).toEqual([320, 180]);
  expect(values.noise[0]).toBe(values.noise[1]);
  expect(values.noise[0]).toBeGreaterThanOrEqual(-1); expect(values.noise[0]).toBeLessThanOrEqual(1);
});
