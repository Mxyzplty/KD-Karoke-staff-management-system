// SPDX-License-Identifier: AGPL-3.0-only
import React from 'react';
import { interpolate, spring, springDuration, type Ease, type SpringConfig } from './math';
import { supportedOptions } from './errors';
export type Timing = { getDurationInFrames: (c: { fps: number }) => number; getProgress: (c: { frame: number; fps: number }) => number };
export function linearTiming(o: { durationInFrames: number; easing?: Ease }): Timing {
  supportedOptions('linearTiming', o, ['durationInFrames', 'easing']); if (!(o.durationInFrames > 0)) throw Error('Transition duration must be positive.');
  return { getDurationInFrames: () => o.durationInFrames, getProgress: ({ frame }) => interpolate(frame, [0, o.durationInFrames], [0, 1], { easing: o.easing, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) };
}
export function springTiming(o: { config?: SpringConfig; durationInFrames?: number; durationRestThreshold?: number } = {}): Timing {
  supportedOptions('springTiming', o, ['config', 'durationInFrames', 'durationRestThreshold']);
  return { getDurationInFrames: ({ fps }) => o.durationInFrames ?? springDuration(fps, o.config, o.durationRestThreshold), getProgress: ({ frame, fps }) => spring({ frame, fps, ...o }) };
}
export type Presentation = { type: 'fade' | 'slide' | 'wipe'; direction?: string; enterStyle?: React.CSSProperties; exitStyle?: React.CSSProperties; shouldFadeOutExitingScene?: boolean };
export function fade(o: { enterStyle?: React.CSSProperties; exitStyle?: React.CSSProperties; shouldFadeOutExitingScene?: boolean } = {}): Presentation { supportedOptions('fade', o, ['enterStyle', 'exitStyle', 'shouldFadeOutExitingScene']); return { type: 'fade', ...o }; }
export function slide(o: { direction?: string; enterStyle?: React.CSSProperties; exitStyle?: React.CSSProperties } = {}): Presentation {
  supportedOptions('slide', o, ['direction', 'enterStyle', 'exitStyle']); const direction = o.direction ?? 'from-left';
  if (!['from-left', 'from-right', 'from-top', 'from-bottom'].includes(direction)) throw Error(`Unsupported slide direction '${direction}'.`);
  return { type: 'slide', ...o, direction };
}
export function wipe(o: { direction?: string } = {}): Presentation {
  supportedOptions('wipe', o, ['direction']); const direction = o.direction ?? 'from-left';
  if (!['from-left', 'from-right', 'from-top', 'from-bottom', 'from-top-left', 'from-top-right', 'from-bottom-left', 'from-bottom-right'].includes(direction)) throw Error(`Unsupported wipe direction '${direction}'.`);
  return { type: 'wipe', direction };
}
export function presentationStyle(p: Presentation, progress: number, entering: boolean): React.CSSProperties {
  const style = entering ? p.enterStyle : p.exitStyle;
  if (p.type === 'fade') return { ...style, opacity: entering ? progress : p.shouldFadeOutExitingScene ? 1 - progress : 1 };
  const direction = p.direction ?? 'from-left';
  if (p.type === 'slide') {
    const horizontal = direction === 'from-left' || direction === 'from-right', sign = direction === 'from-left' || direction === 'from-top' ? -1 : 1;
    return { ...style, transform: `translate${horizontal ? 'X' : 'Y'}(${(entering ? 1 - progress : -progress) * sign * 100}%)` };
  }
  if (!entering) return {};
  const q = Math.max(0, Math.min(1, progress)), edge = (1 - q) * 100;
  const diagonal: Record<string, string> = {
    'from-top-left': `polygon(0 0, ${q * 200}% 0, 0 ${q * 200}%)`,
    'from-top-right': `polygon(100% 0, ${100 - q * 200}% 0, 100% ${q * 200}%)`,
    'from-bottom-left': `polygon(0 100%, 0 ${100 - q * 200}%, ${q * 200}% 100%)`,
    'from-bottom-right': `polygon(100% 100%, ${100 - q * 200}% 100%, 100% ${100 - q * 200}%)`,
  };
  return { clipPath: diagonal[direction] ?? `inset(${direction === 'from-bottom' ? edge : 0}% ${direction === 'from-left' ? edge : 0}% ${direction === 'from-top' ? edge : 0}% ${direction === 'from-right' ? edge : 0}%)` };
}
export type SeriesSequenceProps = { durationInFrames: number; offset?: number; children?: React.ReactNode; [key: string]: unknown };
export type SeriesTransitionProps = { timing: Timing; presentation?: Presentation };
export const SeriesSequence = (_: SeriesSequenceProps): React.ReactNode => null;
export const SeriesTransition = (_: SeriesTransitionProps): React.ReactNode => null;
export function seriesLayout(children: React.ReactNode, fps: number) {
  const elements = React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement<any>[];
  let cursor = 0; const scenes: { start: number; end: number; element: React.ReactElement<SeriesSequenceProps>; incoming?: SeriesTransitionProps; outgoing?: SeriesTransitionProps }[] = [];
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (e.type === SeriesSequence) {
      supportedOptions('TransitionSeries.Sequence', e.props, ['durationInFrames','offset','name','layout','style','className','premountFor','postmountFor','showInTimeline','width','height','children']);
      if (!(e.props.durationInFrames > 0)) throw Error('TransitionSeries.Sequence duration must be positive.');
      const start = cursor + (e.props.offset ?? 0), incoming = elements[i - 1]?.type === SeriesTransition ? elements[i - 1].props : undefined, outgoing = elements[i + 1]?.type === SeriesTransition ? elements[i + 1].props : undefined;
      for (const t of [incoming, outgoing]) if (t && t.timing.getDurationInFrames({ fps }) > e.props.durationInFrames) throw Error('Transition duration cannot exceed an adjacent scene.');
      scenes.push({ start, end: start + e.props.durationInFrames, element: e, incoming, outgoing }); cursor = start + e.props.durationInFrames;
    } else if (e.type === SeriesTransition) {
      supportedOptions('TransitionSeries.Transition', e.props, ['timing','presentation']);
      if (elements[i - 1]?.type === SeriesTransition || elements[i + 1]?.type === SeriesTransition) throw Error('Two transitions cannot be adjacent.');
      const before = elements[i - 1]?.type === SeriesSequence, after = elements[i + 1]?.type === SeriesSequence;
      if (!before && !after) throw Error('A transition needs a sequence before or after it.');
      if (before && after) cursor -= e.props.timing.getDurationInFrames({ fps });
    } else throw Error('TransitionSeries only accepts Sequence and Transition children.');
  }
  return { scenes, durationInFrames: cursor };
}
