// SPDX-License-Identifier: AGPL-3.0-only
// T09 caption agent tools on the T03 command path (agent tool contracts addCaptions; results §2 editAllCaptionStyles, §12
// G-18). addCaptions builds caption items from the sources' transcripts (generation.ts); editAllCaptionStyles restyles a
// whole caption track (properties.ts); listCaptionTemplates is a read-only list of the nine templates (templates.ts). The
// transcripts the sync handler reads are loaded first by the agent path (captions/agent.ts) into `ctx.captionData`; with
// none it captions nothing. Xapp gives no stored result for addCaptions / listCaptionTemplates, so those result envelopes
// are Cutframe's own (notes Q4); parity is on the stored G-18 caption items, not the envelope.
import type { ProjectDocument, RecordData } from '../store/model';
import { CommandError, fail, toMs, track } from '../timeline/model';
import type { CommandBus, Label } from '../timeline/bus';
import { findFont } from '../text/font-registry';
import type { ToolContext, ToolResult } from '../timeline/tools';
import { CHUNK_DEFAULTS } from './chunker';
import type { SourceButton, SourceData } from './generation';
import { bindingStyle, captionTracks, generate } from './generation';
import type { CaptionStyleRecord } from './model';
import { editAllCaptionStyles as editAllOnTrack } from './properties';
import { AGENT_STYLE, findTemplate, PANEL_STYLE, templateOptions, templateStyle, TEMPLATES } from './templates';
import type { StyleSpec } from './templates';
import { defaultFont } from '../templates/model';

type Handler = (ctx: ToolContext, args: RecordData) => ToolResult;
/** No transcripts loaded (the sync UI path, or the agent path before prep): every asset reads as never analysed. */
export const NO_CAPTION_DATA: SourceData = { status: 'none', transcript: null, music: false };
const run = (ctx: ToolContext, label: Label, op: Parameters<CommandBus['run']>[2]) => ctx.bus.run(label, 'agent', op) as ToolResult;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The agent `source` enum (`speech`/`music`/`all`) → the generation button; `music` is the lyrics-only pick. */
const BUTTON = { speech: 'speech', music: 'lyrics', all: 'all' } as const;
/** The panel carries a generation button directly (it has Video only / Voiceover picks the agent enum has no word for); the
 *  agent's three-value `source` remaps through BUTTON. TC-4: the panel's Everything is the `speech` filter (skips voice-overs);
 *  only its Voiceover button captions them, so the panel never passes `all`. */
const PANEL_BUTTONS: readonly string[] = ['speech', 'video', 'voiceover', 'lyrics', 'all'];

/** The base look without a caption template. T22 (plan P4, ruling OQ-1): in a project bound to a project template, it takes
 *  the template's captions font when this browser has it (an explicit font, or a chosen caption template, still wins). */
function baseStyle(doc: ProjectDocument, fromPanel: boolean): StyleSpec {
  const base: StyleSpec = { ...(fromPanel ? PANEL_STYLE : AGENT_STYLE) }, m = findFont(defaultFont(doc, 'captionsFont') ?? '');
  if (!m) return base;
  base.family = m.entry.family;
  if (m.variant) { base.fontWeight = String(m.variant.weight); base.fontStyle = m.variant.italic ? 'italic' : 'normal'; }
  return base;
}
/** The look addCaptions writes: the template (if any) with the agent's style fields on top, else AGENT_STYLE with them.
 *  Validates `font` against the registry (FONT_UNAVAILABLE). Returns the spec, or null when no style argument is given. */
function styleFrom(doc: ProjectDocument, args: RecordData, size: { width: number; height: number }, fromPanel = false): StyleSpec | null {
  const t = args.templateId !== undefined ? findTemplate(args.templateId) : undefined;
  if (args.templateId !== undefined && !t) fail('CAPTION_TEMPLATE_NOT_FOUND', 'Caption template not found', { message: `No caption template '${String(args.templateId)}'. Call listCaptionTemplates for the available ids.` });
  const given = ['font', 'fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'color', 'backgroundColor', 'textDecoration', 'borderColor', 'borderWidth', 'boxShadow'].some(k => args[k] !== undefined);
  if (!t && !given) return null;
  // The panel's Size / Stroke build on the manual default (PANEL_STYLE, §46.5); the agent's style fields build on AGENT_STYLE.
  const spec: StyleSpec = t ? templateStyle(t, size) : baseStyle(doc, fromPanel);
  if (args.font !== undefined) {
    const m = typeof args.font === 'string' ? findFont(args.font) : null;
    if (!m) fail('FONT_UNAVAILABLE', 'Font not available', { message: `Font '${String(args.font)}' is not available. Call the fonts tool for the fonts you can use, or omit font for the default.` });
    spec.family = m!.entry.family;
    if (m!.variant) { spec.fontWeight = String(m!.variant.weight); spec.fontStyle = m!.variant.italic ? 'italic' : 'normal'; }
  }
  if (num(args.fontSize)) spec.fontSize = args.fontSize;
  if (typeof args.color === 'string') spec.color = args.color;
  if (typeof args.backgroundColor === 'string') spec.backgroundColor = args.backgroundColor;
  if (typeof args.borderColor === 'string') spec.borderColor = args.borderColor;
  if (num(args.borderWidth)) spec.borderWidth = args.borderWidth;
  if (fromPanel) {
    if (typeof args.fontFamily === 'string') spec.family = args.fontFamily;
    if (typeof args.fontWeight === 'string') spec.fontWeight = args.fontWeight;
    if (typeof args.fontStyle === 'string') spec.fontStyle = args.fontStyle;
    if (typeof args.textDecoration === 'string') spec.textDecoration = args.textDecoration;
    if (args.boxShadow && typeof args.boxShadow === 'object') spec.boxShadow = args.boxShadow;
  }
  return spec;
}

// ---- addCaptions. `data` names each asset's transcript / music state (loaded by captions/agent.ts).
export function addCaptionsIn(doc: ProjectDocument, args: RecordData, data: (assetId: string) => SourceData, fromPanel = false): ToolResult {
  const split = args.splitBySpeaker === true, size = doc.size;
  // The agent must name the target caption track(s); the panel (fromPanel) leaves them to generate() — pickTrack / speakerTrack
  // find-or-create. Any ids the panel does pass are still validated, so a bad panel id refuses exactly like the agent's.
  if (split) {
    if (!fromPanel && (!Array.isArray(args.speakerTrackIds) || !args.speakerTrackIds.length)) fail('MISSING_TRACK_ID', 'speakerTrackIds is required with splitBySpeaker', { message: 'splitBySpeaker needs speakerTrackIds: the existing caption tracks, in detected-speaker order.' });
    // TC-2: speakerTrackIds are existing caption tracks — validate every id with the trackId path's checks, before any change (atomic).
    if (Array.isArray(args.speakerTrackIds)) for (const id of (args.speakerTrackIds as unknown[]).map(String)) {
      const t = track(doc, id);
      if (!t) fail('TRACK_NOT_FOUND', 'Track not found', { message: `Caption track '${id}' not found. Call context() for current track ids.` });
      if (t.kind !== 'caption') fail('INVALID_TRACK', `Track '${id}' is not a caption track`, { message: `addCaptions targets caption tracks, but '${id}' is a ${t.kind} track.` });
    }
  } else {
    if (!fromPanel && (typeof args.trackId !== 'string' || !args.trackId)) fail('MISSING_TRACK_ID', 'trackId is required', { message: 'addCaptions needs a target caption trackId (or splitBySpeaker with speakerTrackIds). Create one with manageTrack.' });
    if (typeof args.trackId === 'string' && args.trackId) {
      const t = track(doc, args.trackId);
      if (!t) fail('TRACK_NOT_FOUND', 'Track not found', { message: `Caption track '${args.trackId}' not found. Call context() for current track ids.` });
      if (t.kind !== 'caption') fail('INVALID_TRACK', `Track '${args.trackId}' is not a caption track`, { message: `addCaptions targets a caption track, but '${args.trackId}' is a ${t.kind} track.` });
    }
  }
  const template = args.templateId !== undefined ? findTemplate(args.templateId) : undefined, spec = styleFrom(doc, args, size, fromPanel);
  const chunk = { ...(template ? templateOptions(template, size) : CHUNK_DEFAULTS) };
  if (!template && num(args.maxWords)) chunk.maxWords = args.maxWords;
  if (!template && num(args.maxCharacters)) chunk.maxCharacters = args.maxCharacters;
  // The two break flags are the panel's Generation Settings (the agent has no flag inputs — CAP-P09: an omitted flag stays on).
  if (!template && fromPanel && typeof args.breakOnPunctuation === 'boolean') chunk.breakOnPunctuation = args.breakOnPunctuation;
  if (!template && fromPanel && typeof args.breakOnConjunctions === 'boolean') chunk.breakOnConjunctions = args.breakOnConjunctions;
  const ranged = args.startTime !== undefined || args.endTime !== undefined;
  const range = ranged ? { startMs: num(args.startTime) ? toMs(args.startTime) : 0, endMs: num(args.endTime) ? toMs(args.endTime) : Number.MAX_SAFE_INTEGER } : null;
  const button: SourceButton = fromPanel
    ? (typeof args.source === 'string' && PANEL_BUTTONS.includes(args.source) ? args.source as SourceButton : 'speech')
    : (typeof args.source === 'string' && args.source in BUTTON ? BUTTON[args.source as keyof typeof BUTTON] : 'speech');
  // The panel's manual-caption default is Open Sans Regular (§46.5); the agent's no-style default is Roboto Bold (G-18, §12).
  const fallback: CaptionStyleRecord = bindingStyle(baseStyle(doc, fromPanel), size.height);
  const o = {
    button, sourceItems: Array.isArray(args.sourceItems) ? args.sourceItems.map(String) : undefined, range, split,
    trackId: split ? undefined : (typeof args.trackId === 'string' && args.trackId ? args.trackId : undefined),
    speakerTrackIds: split && Array.isArray(args.speakerTrackIds) ? (args.speakerTrackIds as unknown[]).map(String) : undefined,
    chunk, style: spec ? bindingStyle(spec, size.height) : undefined, templateId: template ? template.id : undefined, reset: args.reset === true,
  };
  const g = generate(doc, o, data, fallback);
  const data0: RecordData = { captionIds: g.created, captionCount: g.created.length, ...(split ? { speakers: g.speakers } : { trackId: g.trackIds[0] ?? (args.trackId as string), trackIds: g.trackIds }) };
  if (g.removed) data0.replacedCount = g.removed;
  if (g.inaudible.length) data0.inaudibleSources = g.inaudible;
  if (g.unresolved.length) data0.unresolvedSources = g.unresolved;
  const where = split ? `${(g.speakers ?? []).length} speaker track(s)` : `track '${g.trackIds[0] ?? o.trackId}'`;
  const warn = g.inaudible.length ? ` ${g.inaudible.length} source(s) were inaudible and produced no words; make them audible (unmute / unhide) and run addCaptions again.` : '';
  const result: ToolResult = { success: true, message: `Added ${g.created.length} caption${g.created.length === 1 ? '' : 's'} on ${where}.${warn}`, data: data0 };
  if (g.inaudible.length) result.warning = 'INAUDIBLE_SOURCES';
  return result;
}
const addCaptions: Handler = (ctx, args) => run(ctx, 'Add captions', doc => addCaptionsIn(doc, args, ctx.captionData ?? (() => NO_CAPTION_DATA)));
/** The Captions panel's Generate (runtime generateCaptions intent): like addCaptions, but the panel leaves its caption
 *  track(s) to generate() (pickTrack / speakerTrack) and its no-template look is PANEL_STYLE. The resolved transcript
 *  provider travels from the panel; the handler runs it on the bus under 'Add captions' / 'Regenerate captions'. */
export const addCaptionsPanel = (doc: ProjectDocument, args: RecordData, data: (assetId: string) => SourceData): ToolResult => addCaptionsIn(doc, args, data, true);

// ---- editAllCaptionStyles. The message lists only the results §2 property names; other changes are silent.
const LABELS: [string, (v: unknown) => string][] = [
  ['font', v => `font: ${String(v).replace(/-/g, ' ')}`], ['renderMode', v => `render mode: ${v}`], ['highlightColor', v => `highlight color: ${v}`],
  ['fontSize', v => `size: ${v}px`], ['color', v => `color: ${v}`], ['backgroundColor', v => `background: ${v}`], ['textAlign', v => `align: ${v}`],
  ['lineHeight', v => `line spacing: ${v}×`], ['opacity', v => `opacity: ${v}%`], ['borderWidth', v => `border: ${v}px`], ['borderColor', v => `border color: ${v}`],
  ['boxShadow', () => 'shadow updated'], ['blendMode', v => `blend: ${v}`],
];
const styleMessage = (n: number, props: RecordData) => {
  const parts = LABELS.filter(([k]) => props[k] !== undefined).map(([k, f]) => f(props[k]));
  return `Updated ${n} caption${n === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
};
// Label parity: §45.1 caps the undo set at 52 and has no caption-style label; a caption restyle is a property edit, so it
// writes the generic 'Edit items' (the T11 P2 pattern, where the agent path reuses the UI's label). Provisional — notes.
const editAllCaptionStyles: Handler = (ctx, args) => {
  try { return run(ctx, 'Edit items', doc => {
    const props = (args.properties && typeof args.properties === 'object' && !Array.isArray(args.properties) ? args.properties : args) as RecordData;
    const r = editAllOnTrack(doc, args.trackId as string, props);
    return { success: true, message: styleMessage(r.updatedCount, props), data: { updatedCount: r.updatedCount, updatedIds: r.updatedIds } };
  }); } catch (e) {
    if (e instanceof CommandError) throw e;
    const reason = e instanceof Error ? e.message : String(e);
    return { success: false, code: 'BATCH_UPDATE_FAILED', error: 'Batch caption update failed', message: `Failed to update caption styles: ${reason}` };
  }
};

// ---- listCaptionTemplates (read-only). `defaultColor` is Cutframe's own deterministic palette (unmeasured, notes Q4).
const DEFAULT_COLORS = ['#FFFFFF', '#E6C069', '#FFE600', '#4FC3F7', '#FF8A65', '#AED581', '#CE93D8', '#E5987D'];
const listCaptionTemplates: Handler = () => ({
  success: true,
  data: {
    templates: TEMPLATES.map((t, n) => ({ id: t.id, name: t.name, description: t.description, tags: t.tags, accentColors: t.accentColors,
      defaultColor: t.style.color ?? DEFAULT_COLORS[n % DEFAULT_COLORS.length], maxWords: t.limits.maxWords, maxCharacters: t.limits.maxCharacters })),
  },
});

export const CAPTION_TOOLS: Record<string, Handler> = { addCaptions, editAllCaptionStyles, listCaptionTemplates };
export { captionTracks };
