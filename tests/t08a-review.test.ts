// SPDX-License-Identifier: AGPL-3.0-only
import React from 'react';
import { expect, it } from 'vitest';
import { compileMotionGraphic } from '../apps/web/src/mg/compiler';
import { MotionGraphicError, trustedError } from '../apps/web/src/mg/errors';
import { linearTiming, springTiming, SeriesSequence, SeriesTransition, seriesLayout } from '../apps/web/src/mg/transitions';

it('does not interpret inherited media property names as native media', () => {
  expect(() => compileMotionGraphic('export const Graphic = () => <toString/>;')).not.toThrow();
});

it('trusts only issued, allowlisted error snapshots', () => {
  expect(trustedError({ code: 'MG_MEMORY_LIMIT', message: 'forged' })).toBeUndefined();
  expect(trustedError(new MotionGraphicError('invented', 'forged'))).toBeUndefined();
  const error = new MotionGraphicError('MG_MEMORY_LIMIT', 'original');
  error.code = 'invented'; error.message = 'edited';
  expect(trustedError(error)).toEqual({ code: 'MG_MEMORY_LIMIT', message: 'original' });
});

it('pins the measured spring timing values at 30 fps', () => {
  expect(springTiming({ config: { damping: 200 } }).getDurationInFrames({ fps: 30 })).toBe(23);
  expect(springTiming().getDurationInFrames({ fps: 30 })).toBe(28);
});

it('accepts a transition with a sequence before or after it and rejects adjacent transitions', () => {
  const scene = React.createElement(SeriesSequence, { durationInFrames: 30 });
  const transition = React.createElement(SeriesTransition, { timing: linearTiming({ durationInFrames: 10 }) });
  expect(seriesLayout([transition, scene], 30).durationInFrames).toBe(30);
  expect(seriesLayout([scene, transition], 30).durationInFrames).toBe(30);
  expect(seriesLayout([scene, transition, scene], 30).durationInFrames).toBe(50);
  expect(() => seriesLayout([transition], 30)).toThrow(/before or after/);
  expect(() => seriesLayout([scene, transition, transition, scene], 30)).toThrow(/adjacent/);
});

it('validates TransitionSeries child options', () => {
  expect(() => seriesLayout(React.createElement(SeriesSequence, { durationInFrames: 30, unsupported: true }), 30)).toThrow(/unsupported option/);
  expect(() => seriesLayout([
    React.createElement(SeriesSequence, { durationInFrames: 30 }),
    React.createElement(SeriesTransition, { timing: linearTiming({ durationInFrames: 10 }), unsupported: true } as any),
  ], 30)).toThrow(/unsupported option/);
});
