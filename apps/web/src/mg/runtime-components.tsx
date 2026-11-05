// SPDX-License-Identifier: AGPL-3.0-only
import React, { createContext, useContext, useLayoutEffect, useRef } from 'react';
import lottie from 'lottie-web';
import { createRoot as createThreeRoot, advance, extend, type RootState } from '@react-three/fiber';
import * as THREE from 'three';
import * as math from './math';
import * as shapes from './shapes';
import * as paths from './paths';
import * as transitions from './transitions';
import { MotionGraphicError, supportedOptions } from './errors';
import { ALLOWED_TAGS, MEDIA_REFUSALS, THREE_TAG_PATTERN } from './policy';
import { PARITY } from './parity-switches';
import { showFrameAt } from './video-frame';
extend(THREE as any);
/** onMediaWait: called with true as each media load (Img, OffthreadVideo) starts waiting and with false when none is left;
 *  the watchdogs credit idle time in that window to the media budget (T08 notes, watchdog).
 *  itemWidth/itemHeight: the item box the graphic is laid out in (D25); width/height stay the canvas (useVideoConfig).
 *  frameStarts: each video asset's frame starts by asset id, for the OffthreadVideo hold (video-frame.ts). */
export type RuntimeConfig = { frame?: number; fps?: number; width?: number; height?: number; itemWidth?: number; itemHeight?: number; durationInFrames?: number; fieldValues?: Record<string, unknown>; assetMap?: Record<string, string>; frameStarts?: Record<string, number[]>; dryRun?: boolean; onMediaWait?: (waiting: boolean) => void };
type Context = { frame: number; width: number; height: number };
export const API_NAMES = ['React','useState','useEffect','useMemo','useRef','useCallback','AbsoluteFill','interpolate','interpolateColors','useCurrentFrame','useVideoConfig','spring','Easing','Sequence','Img','OffthreadVideo','Rect','Circle','Triangle','Star','Polygon','Ellipse','Heart','Pie','makeRect','makeCircle','makeTriangle','makeStar','makePolygon','makeEllipse','makeHeart','makePie','evolvePath','interpolatePath','noise3D','TransitionSeries','linearTiming','springTiming','fade','slide','wipe','Lottie','ThreeCanvas','getAssetUrl','itemWidth','itemHeight','editable'] as const;
export function createRuntime(config: RuntimeConfig = {}) {
  const { frame = 0, fps = 30, width = 1080, height = 1920, itemWidth = width, itemHeight = height, durationInFrames = 150, fieldValues = {}, assetMap = {}, frameStarts = {}, dryRun = false, onMediaWait } = config;
  const FrameContext = createContext<Context>({ frame, width, height });
  const pending = new Set<Promise<unknown>>(), media = new Set<Promise<unknown>>(), cleanups: (() => void)[] = [], fields = new Map<string, { name: string; defaultValue: unknown; meta?: unknown }>();
  let failure: unknown;
  const hold = (promise: Promise<unknown>, isMedia = false) => {
    pending.add(promise);
    if (isMedia) { media.add(promise); onMediaWait?.(true); }
    promise.catch(e => { failure = e; }).finally(() => { pending.delete(promise); if (media.delete(promise) && media.size === 0) onMediaWait?.(false); });
  };
  const context = () => dryRun ? { frame, width, height } : useContext(FrameContext);
  const useCurrentFrame = () => context().frame;
  const useVideoConfig = () => { const c = context(); return { fps, width: c.width, height: c.height, durationInFrames, id: undefined, props: {}, defaultProps: {} }; };
  const AbsoluteFill = (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', ...props.style }} />;
  const Sequence = (props: { from?: number; durationInFrames?: number; name?: string; layout?: 'absolute-fill' | 'none'; style?: React.CSSProperties; className?: string; premountFor?: number; postmountFor?: number; showInTimeline?: boolean; width?: number; height?: number; children?: React.ReactNode }) => {
    supportedOptions('Sequence', props, ['from','durationInFrames','name','layout','style','className','premountFor','postmountFor','showInTimeline','width','height','children']);
    const c = context(), { from = 0, durationInFrames: duration = Infinity } = props;
    const premountFor = Math.max(0, Math.floor(props.premountFor ?? 0)), postmountFor = Math.max(0, Math.floor(props.postmountFor ?? 0));
    // Q5 (parity-switches): Xapp's export also draws the end frame from + durationInFrames.
    const end = from + duration + (PARITY.sequenceEnd === 'xapp-export' ? 1 : 0);
    if (c.frame < from - premountFor || c.frame >= end + postmountFor) return null;
    if (dryRun) return props.children;
    const child = <FrameContext.Provider value={{ frame: Math.max(0, Math.min(c.frame - from, end - from - 1)), width: props.width ?? c.width, height: props.height ?? c.height }}>{props.children}</FrameContext.Provider>;
    const visible = c.frame >= from && c.frame < end;
    if (props.layout === 'none') return visible ? child : <div style={{ display: 'none' }}>{child}</div>;
    if (props.layout !== undefined && props.layout !== 'absolute-fill') throw Error(`Unsupported Sequence layout '${props.layout}'.`);
    return <AbsoluteFill className={props.className} style={{ width: props.width ?? c.width, height: props.height ?? c.height, ...(PARITY.sequenceStyle === 'drawn' ? props.style : {}), ...(!visible ? { display: 'none' } : {}) }}>{child}</AbsoluteFill>;
  };
  const TransitionSeries = Object.assign((props: { children?: React.ReactNode; style?: React.CSSProperties; className?: string }) => {
    supportedOptions('TransitionSeries', props, ['children','style','className']);
    const c = context(), { scenes } = transitions.seriesLayout(props.children, fps);
    return <AbsoluteFill style={props.style} className={props.className}>{scenes.filter(scene => c.frame >= scene.start && c.frame < scene.end).map((scene, i) => {
      let style: React.CSSProperties = {};
      if (scene.incoming) { const duration = scene.incoming.timing.getDurationInFrames({ fps }); if (c.frame < scene.start + duration) style = transitions.presentationStyle(scene.incoming.presentation ?? transitions.slide(), scene.incoming.timing.getProgress({ frame: c.frame - scene.start, fps }), true); }
      if (scene.outgoing) { const duration = scene.outgoing.timing.getDurationInFrames({ fps }); if (c.frame >= scene.end - duration) style = { ...style, ...transitions.presentationStyle(scene.outgoing.presentation ?? transitions.slide(), scene.outgoing.timing.getProgress({ frame: c.frame - (scene.end - duration), fps }), false) }; }
      // G-06: scenes retain the graphic clock. Ordinary Sequence below still rebases.
      const p = scene.element.props;
      if (p.layout === 'none' && Object.keys(style).length === 0) return <React.Fragment key={i}>{p.children}</React.Fragment>;
      return <AbsoluteFill key={i} className={p.className as string} style={{ ...(p.style as React.CSSProperties), ...style }}>{p.children}</AbsoluteFill>;
    })}</AbsoluteFill>;
  }, { Sequence: transitions.SeriesSequence, Transition: transitions.SeriesTransition });
  // The id is carried on the refusal so the host can look it up and run again: the map holds only the ids the code writes as
  // literals, so a constant or computed id is not in it (index.ts render, frames.ts attachedUrl). The text is unchanged.
  const getAssetUrl = (id: string) => { if (!Object.hasOwn(assetMap, id)) throw new MotionGraphicError('VALIDATION_ERROR', `getAssetUrl() takes a project asset's agentId. '${id}' is not an asset attached to this project.`, { assetId: id }); return assetMap[id]; };
  const editable = (name: string, defaultValue: unknown, meta?: { type?: string; [key: string]: unknown }) => {
    const type = meta?.type ?? (Array.isArray(defaultValue) ? 'text[]' : typeof defaultValue);
    if (!['text','string','number','color','boolean','text[]','font','select'].includes(type)) throw Error(`Unsupported editable field type '${type}'.`);
    const value = !dryRun && Object.hasOwn(fieldValues, name) ? fieldValues[name] : defaultValue;
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)) || type === 'boolean' && typeof value !== 'boolean' || type === 'text[]' && (!Array.isArray(value) || value.some(v => typeof v !== 'string')) || ['text','string','color','font','select'].includes(type) && typeof value !== 'string') throw Error(`Invalid editable field '${name}' of type '${type}'.`);
    fields.set(name, { name, defaultValue, meta }); return value;
  };
  const mediaAllowed = (src: string) => { if (!Object.values(assetMap).includes(src)) throw new MotionGraphicError('VALIDATION_ERROR', 'Media URLs must be provided by the host asset map.'); };
  const Img = (props: any) => {
    supportedOptions('Img', props, ['src','style','className','onError','pauseWhenLoading','delayRenderTimeoutInMilliseconds']);
    if (dryRun) return null; mediaAllowed(props.src); const ref = useRef<HTMLImageElement>(null);
    useLayoutEffect(() => { const el = ref.current!; hold(new Promise<void>((resolve, reject) => {
      if (el.complete) { if (el.naturalWidth) resolve(); else { props.onError?.(new Event('error')); reject(Error('Image could not be loaded.')); } return; }
      const timer = setTimeout(() => reject(Error('Image load timeout.')), Math.min(1800, props.delayRenderTimeoutInMilliseconds ?? 1800));
      el.onload = () => { clearTimeout(timer); resolve(); }; el.onerror = e => { clearTimeout(timer); props.onError?.(e); reject(Error('Image could not be loaded.')); };
    }), true); }, [props.src]);
    return <img ref={ref} src={props.src} style={props.style} className={props.className} />;
  };
  const OffthreadVideo = (props: any) => {
    supportedOptions('OffthreadVideo', props, ['src','trimBefore','trimAfter','startFrom','endAt','playbackRate','volume','muted','toneMapped','transparent','style','pauseWhenLoading','delayRenderTimeoutInMilliseconds']);
    const f = useCurrentFrame(); if (dryRun) return null; mediaAllowed(props.src); const ref = useRef<HTMLVideoElement>(null);
    // Source frame = trimBefore + playbackRate · f (startFrom / endAt are the older names); from trimAfter on nothing is drawn.
    const before = props.trimBefore ?? props.startFrom ?? 0, after = props.trimAfter ?? props.endAt ?? Infinity;
    const source = before + f * (props.playbackRate ?? 1);
    // Q7 (D29): 'undivided' cuts `endAt` at graphic frame (endAt - trimBefore), as Remotion 4.0.427 does; `trimAfter` is
    // a source frame either way.
    const shown = (PARITY.endAt === 'undivided' && props.trimAfter === undefined ? before + f : source) < after;
    // The hold ends once the source's frame at that time is the one shown (video-frame.ts), not at `seeked`.
    const asset = Object.keys(assetMap).find(id => assetMap[id] === props.src), starts = asset === undefined ? undefined : frameStarts[asset];
    useLayoutEffect(() => { if (!shown) return; hold(showFrameAt(ref.current!, Math.max(0, source) / fps, fps, Math.min(1800, props.delayRenderTimeoutInMilliseconds ?? 1800), starts), true); }, [props.src, source, shown]);
    return shown ? <video ref={ref} src={props.src} muted playsInline preload="auto" style={props.style} /> : null;
  };
  const Lottie = (props: any) => {
    supportedOptions('Lottie', props, ['animationData','loop','playbackRate','direction','renderer','preserveAspectRatio','assetsPath','style','className','onAnimationLoaded']);
    const f = useCurrentFrame(); if (dryRun) return null; const ref = useRef<HTMLDivElement>(null);
    if (!props.animationData) throw Error('Lottie animationData is required.');
    if (props.direction !== undefined && !['forward','backward'].includes(props.direction)) throw Error('Unsupported Lottie direction.');
    useLayoutEffect(() => {
      const animation = lottie.loadAnimation({ container: ref.current!, renderer: props.renderer ?? 'svg', animationData: structuredClone(props.animationData), loop: false, autoplay: false, assetsPath: props.assetsPath, rendererSettings: { preserveAspectRatio: props.preserveAspectRatio ?? 'xMidYMid meet' } });
      hold(new Promise<void>((resolve, reject) => {
        const show = () => { const length = animation.totalFrames; let at = f * (props.playbackRate ?? 1); at = props.loop ? ((at % length) + length) % length : Math.max(0, Math.min(length - 1, at)); if (props.direction === 'backward') at = length - 1 - at; animation.goToAndStop(at, true); props.onAnimationLoaded?.(animation); resolve(); };
        animation.addEventListener('DOMLoaded', show); animation.addEventListener('data_failed', () => reject(Error('Lottie could not be loaded.'))); if (animation.isLoaded) show();
      }));
      return () => animation.destroy();
    }, [props.animationData, f]);
    return <div ref={ref} style={props.style} className={props.className} />;
  };
  const ThreeCanvas = (props: any) => {
    supportedOptions('ThreeCanvas', props, ['width','height','camera','orthographic','gl','style','children','shadows','linear','flat','scene']);
    if (props.gl !== undefined && (props.gl === null || typeof props.gl !== 'object' || Object.getPrototypeOf(props.gl) !== Object.prototype)) throw new MotionGraphicError('UNSUPPORTED_OPTION', 'ThreeCanvas: gl must be a plain options object.');
    const c = context(); if (dryRun) return null; const ref = useRef<HTMLCanvasElement>(null);
    if (!(props.width > 0 && props.height > 0 && props.width * props.height <= 4096 * 4096)) throw Error('ThreeCanvas width and height are required and must fit the memory budget.');
    useLayoutEffect(() => {
      const root = createThreeRoot(ref.current!); let state: RootState | undefined;
      const { width: w, height: h, style: _style, children, ...options } = props;
      hold((async () => {
        await root.configure({ ...options, size: { width: w, height: h, top: 0, left: 0 }, dpr: 1, frameloop: 'never', gl: { alpha: true, antialias: false, preserveDrawingBuffer: true, ...(options.gl ?? {}) }, onCreated: (s: RootState) => { state = s; } });
        root.render(<FrameContext.Provider value={c}>{children}</FrameContext.Provider>);
        await new Promise<void>(resolve => setTimeout(resolve, 16));
        if (!state) throw Error('ThreeCanvas did not initialise.'); advance(c.frame / fps, true, state);
      })());
      const cleanup = () => root.unmount(); cleanups.push(cleanup); return cleanup;
    }, [c.frame]);
    return <canvas ref={ref} width={props.width} height={props.height} style={props.style} />;
  };
  const hooks = dryRun ? { useState: (v: any) => [typeof v === 'function' ? v() : v, () => {}], useEffect: () => {}, useMemo: (f: any) => f(), useRef: (v: any) => ({ current: v }), useCallback: (f: any) => f, useLayoutEffect: () => {}, useContext: (c: any) => c._currentValue } : { useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo, useRef: React.useRef, useCallback: React.useCallback };
  const validateElement = (element: React.ReactElement<any>): React.ReactElement<any> => {
    const tag = element.type, props = element.props;
    if (typeof tag === 'string') {
      if (Object.hasOwn(MEDIA_REFUSALS, tag)) throw new MotionGraphicError('VALIDATION_ERROR', MEDIA_REFUSALS[tag as keyof typeof MEDIA_REFUSALS]);
      if (!ALLOWED_TAGS.has(tag) && !THREE_TAG_PATTERN.test(tag)) throw new MotionGraphicError('VALIDATION_ERROR', `Unsafe <${tag}> element is not supported.`);
      if (tag === 'canvas' && (props.width ?? 300) * (props.height ?? 150) > 4096 * 4096) throw new MotionGraphicError('MG_MEMORY_LIMIT', 'Motion graphic canvas exceeds the memory budget.');
    }
    for (const key of ['dangerouslySetInnerHTML','onBeforeRender','onAfterRender','onBeforeCompile']) if (Object.hasOwn(props, key)) throw new MotionGraphicError('UNSUPPORTED_OPTION', `${key} is not supported in the motion graphic sandbox.`);
    return element;
  };
  const guardedReact = { ...React, ...hooks, createElement: (...args: Parameters<typeof React.createElement>) => validateElement(React.createElement(...args)), cloneElement: (...args: Parameters<typeof React.cloneElement>) => validateElement(React.cloneElement(...args)) };
  const api = { React: guardedReact, ...hooks, AbsoluteFill, interpolate: math.interpolate, interpolateColors: math.interpolateColors, useCurrentFrame, useVideoConfig, spring: math.spring, Easing: math.Easing, Sequence, Img, OffthreadVideo, ...shapes.shapeComponents, makeRect: shapes.makeRect, makeCircle: shapes.makeCircle, makeTriangle: shapes.makeTriangle, makeStar: shapes.makeStar, makePolygon: shapes.makePolygon, makeEllipse: shapes.makeEllipse, makeHeart: shapes.makeHeart, makePie: shapes.makePie, ...paths, TransitionSeries, linearTiming: transitions.linearTiming, springTiming: transitions.springTiming, fade: transitions.fade, slide: transitions.slide, wipe: transitions.wipe, Lottie, ThreeCanvas, getAssetUrl, itemWidth, itemHeight, editable };
  Object.defineProperties(api, {
    settle: { value: async () => { while (pending.size) await Promise.all([...pending]); if (failure) throw failure; } },
    dispose: { value: () => cleanups.forEach(f => f()) }, fields: { value: fields },
  });
  return api as typeof api & { settle(): Promise<void>; dispose(): void; fields: typeof fields };
}
