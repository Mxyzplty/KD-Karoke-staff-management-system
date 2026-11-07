// SPDX-License-Identifier: AGPL-3.0-only
// Editor panels (inventory §2; part 3 §46.1, §46.3, §46.6, §46.9): left panel (Footage with Uploads / Reference, AI), the
// 11-tool rail, the inspector shells (Properties / Effects) and the compact layout's bottom tabs and sheets. Working T14
// panels are reused; every other panel is an entry point naming the ticket that builds it.
import type { ReactNode } from 'react';
import type { ProjectDocument, RecordData } from '../store/model';
import { FootagePanel, ReferencePanel } from '../media-panel';
import { PhotosPanel, SoundsPanel, VideosPanel } from '../stock-ui';
import { GraphicFields } from '../mg/fields';
import { MotionGraphicsPanel } from '../mg/panel';
import { AnimationBody, FontShadowBody, FontStrokeBody, PresetBody, TextBasicBody, TextBody, TextPanel, TextTransformBody } from '../text/ui';
import { dispatch } from './commands';
import { EffectsRail, EffectsTab } from './effects-ui';
import { AppearanceBody, BasicBody, ShadowBody, SpeedBody, TransformBody, VolumeBody } from './inspector';
import { FillBody, ShapePathBody, ShapesPanel, ShapeTransformBody, StrokeBody } from './shape-ui';
import { CellsBody, LayoutsPanel, LayoutStyleBody, LayoutTransformBody } from './layout-ui';
import { maskHeader, MaskBody, RemoveBackground } from './mask-ui';
import { cellsOf, layoutLabel } from '../timeline/layouts';
import { openGraph, setView, TOOLS, useView } from './view';
import type { Tool } from './view';
import { VoiceoverPanel } from './voiceover';

const Unavailable = ({ what, owner }: { what: string; owner: string }) => <p className="unavailable">{what} is not yet implemented ({owner}).</p>;
export function FootageTabs({ projectId }: { projectId: string }) {
  const v = useView();
  return <div className="footage-tabs">
    <div role="tablist" aria-label="Footage">
      <button role="tab" aria-selected={v.footageTab === 'uploads'} onClick={() => setView({ footageTab: 'uploads' })}>Uploads</button>
      <button role="tab" aria-selected={v.footageTab === 'reference'} data-tour="reference-tab" onClick={() => setView({ footageTab: 'reference' })}>Reference</button>
    </div>
    {v.footageTab === 'uploads' ? <FootagePanel projectId={projectId} /> : <ReferencePanel projectId={projectId} />}
  </div>;
}
/** Left panel: Footage and AI (our name for the built-in chat tab; the chat is T20). */
export function LeftPanel({ projectId }: { projectId: string }) {
  const v = useView();
  return <aside className="left-panel" aria-label="Left panel">
    <div role="tablist" aria-label="Left panel">
      <button role="tab" aria-selected={v.left === 'footage'} onClick={() => setView({ left: 'footage' })}>Footage</button>
      <button role="tab" aria-selected={v.left === 'ai'} onClick={() => setView({ left: 'ai' })}>AI</button>
    </div>
    {v.left === 'footage' ? <FootageTabs projectId={projectId} /> : <section aria-label="AI chat"><h3>AI chat</h3><p>No AI provider connected.</p><Unavailable what="The built-in AI chat" owner="T20" /><p>Everything else in the editor works without a provider.</p></section>}
  </aside>;
}
/** A rail tool's panel: the T14 stock panels and T10's effects work; the rest name their owner. */
export function ToolPanel({ tool, projectId }: { tool: Tool; projectId: string }) {
  const info = TOOLS.find(t => t.id === tool)!;
  if (tool === 'videos') return <VideosPanel projectId={projectId} />;
  if (tool === 'photos') return <PhotosPanel />;
  if (tool === 'sounds') return <SoundsPanel projectId={projectId} />;
  if (tool === 'motion') return <MotionGraphicsPanel />;
  if (tool === 'shapes') return <ShapesPanel />;
  if (tool === 'text') return <TextPanel />;
  if (tool === 'layouts') return <LayoutsPanel />;
  if (tool === 'effects') return <EffectsRail />;
  if (tool === 'voiceover') return <VoiceoverPanel projectId={projectId} />;
  return <section aria-label={info.label} className="tool-panel"><h3>{info.label}</h3>
    <Unavailable what={`The ${info.label} panel`} owner={info.owner} />
  </section>;
}
export function Rail() {
  const v = useView();
  return <nav className="rail" aria-label="Tools"><div role="tablist" aria-label="Tools" aria-orientation="vertical">
    {TOOLS.map(t => <button key={t.id} role="tab" aria-selected={v.right.kind === 'tool' && v.right.tool === t.id} onClick={() => setView({ right: { kind: 'tool', tool: t.id } })}>{t.label}</button>)}
  </div></nav>;
}

// ---- Inspector shells (part 3 §46.6, §46.9). Sections and owners per type; `done` sections are built (T04's, in
// inspector.tsx); the rest name the ticket that builds them.
// `rekey` makes a section re-mount (so it collapses again) when the value it names changes. T05's Animation section is
// collapsed by default and re-collapses when the SELECTION changes (W3-ED-14); its rekey therefore keys on item id only.
// It must NOT remount on an animation edit: the Speed slider lives inside this section, so a remount on each tile click or
// slider step would collapse the section (hiding the slider) and drop the pointer capture mid-drag — which W3-RT-02's
// parity-mode drag (1x -> 2x = 4 entries) forbids. (§46.7's "re-collapses when the animation changes" cannot cover the
// in-section edit, since acceptance requires the slider to stay live through it.)
// `heading` (T07) overrides the section's displayed title per item.
type Section = { title: string; owner: string; body?: (doc: ProjectDocument, item: RecordData) => ReactNode; done?: boolean; rekey?: (item: RecordData) => string; heading?: (item: RecordData) => string; onHeader?: (doc: ProjectDocument, item: RecordData) => void };
const owners: Record<string, string> = { video: 'T04', image: 'T04', audio: 'T04', text: 'T05', caption: 'T09', shape: 'T06', motionGraphic: 'T04', layout: 'T07' };
const t04 = (title: string, Body: (p: { doc: ProjectDocument; item: RecordData }) => ReactNode): Section => ({ title, owner: 'T04', done: true, body: (doc, item) => <Body doc={doc} item={item} /> });
const t06 = (title: string, Body: (p: { doc: ProjectDocument; item: RecordData }) => ReactNode): Section => ({ title, owner: 'T06', done: true, body: (doc, item) => <Body doc={doc} item={item} /> });
const t05 = (title: string, Body: (p: { doc: ProjectDocument; item: RecordData }) => ReactNode, rekey?: (item: RecordData) => string): Section => ({ title, owner: 'T05', done: true, rekey, body: (doc, item) => <Body doc={doc} item={item} /> });
const sectionKey = (s: Section, item: RecordData) => s.rekey ? `${s.title}:${item.id}:${s.rekey(item)}` : s.title;
const t07 = (title: string, Body: (p: { doc: ProjectDocument; item: RecordData }) => ReactNode, heading?: Section['heading']): Section => ({ title, owner: 'T07', done: true, heading, body: (doc, item) => <Body key={item.id} doc={doc} item={item} /> });
const MASK: Section = { title: 'Mask', owner: 'T12', done: true, onHeader: maskHeader, body: (doc, item) => <MaskBody doc={doc} item={item} /> };
export const SECTIONS: Record<string, Section[]> = {
  video: [t04('Basic', BasicBody), t04('Speed & Time Remap', SpeedBody), t04('Transform', TransformBody), t04('Appearance', AppearanceBody), MASK, t04('Shadow', ShadowBody)],
  image: [t04('Basic', BasicBody), t04('Transform', TransformBody), t04('Appearance', AppearanceBody), MASK, t04('Shadow', ShadowBody)],
  audio: [t04('Speed', SpeedBody), t04('Volume', VolumeBody)],
  text: [t05('Preset', PresetBody), t05('Text', TextBody), t05('Animation', AnimationBody, () => ''),
    t05('Basic', TextBasicBody), t05('Transform', TextTransformBody), t05('Font Stroke', FontStrokeBody), t05('Font Shadow', FontShadowBody)],
  caption: [{ title: 'Text animation', owner: 'T09' }, { title: 'Word behavior', owner: 'T09' }, { title: 'Caption Text', owner: 'T09' }, { title: 'Text', owner: 'T09' }, { title: 'Transform', owner: 'T09' }, { title: 'Basic', owner: 'T09' }, { title: 'Font Stroke', owner: 'T09' }, { title: 'Font Shadow', owner: 'T09' }],
  shape: [t06('Fill', FillBody), t06('Stroke', StrokeBody), t06('Basic', BasicBody), t06('Transform', ShapeTransformBody), t06('Shape Path', ShapePathBody)],
  motionGraphic: [t04('Basic', BasicBody), t04('Transform', TransformBody)],
  layout: [t07('Cells', CellsBody, item => `Cells (${cellsOf(item).length})`), t07('Style', LayoutStyleBody), t07('Transform', LayoutTransformBody)],
};
const TYPE_NAMES: Record<string, string> = { video: 'Video', image: 'Image', audio: 'Audio', text: 'Text', caption: 'Caption', shape: 'Shape', motionGraphic: 'Motion graphic', layout: 'Layout' };
/** Header: the type name and the Keyframes graph button (not for layouts; it opens the Time Remap graph while remap is
 *  on, §46.11); video adds the Remove Background card. */
function ItemHeader({ item }: { item: RecordData }) {
  // A shape's header names its type, as its stored name does ("Shape heart"; findings §20).
  return <><div className="inspector-heading"><h3>{item.type === 'shape' ? (typeof item.name === 'string' ? item.name : item.details?.shapeType ?? 'Shape') : TYPE_NAMES[item.type] ?? item.type}</h3>
    {item.type === 'layout' && <span className="chip" data-testid="layout-preset">{layoutLabel(item.details?.layoutType)}</span>}
    {item.type !== 'layout' && <button aria-label="Keyframes graph" onClick={() => openGraph(item.id, item.timeRemap ? 'timeRemap' : null)}>⌇</button>}</div>
    {item.type === 'video' && <div className="card"><strong>Remove Background</strong><RemoveBackground item={item} label="Apply" /></div>}</>;
}
function SectionShell({ doc, item, section, open }: { doc: ProjectDocument; item: RecordData; section: Section; open?: boolean }) {
  return <details className="inspector-section" open={open}><summary onClick={() => section.onHeader?.(doc, item)}>{section.heading?.(item) ?? section.title}</summary>{section.body?.(doc, item)}{!section.done && <Unavailable what={`The ${section.title} section`} owner={section.owner} />}</details>;
}
export function Inspector({ doc }: { doc: ProjectDocument }) {
  const v = useView(), item = doc.items.find(i => i.id === v.selection[0]);
  if (!item) return <section className="inspector" aria-label="Inspector"><p>Select an item on the timeline, or choose a tool.</p></section>;
  return <section className="inspector" aria-label="Inspector">
    <div role="tablist" aria-label="Inspector">
      <button role="tab" aria-selected={v.inspectorTab === 'properties'} onClick={() => setView({ inspectorTab: 'properties' })}>Properties</button>
      <button role="tab" aria-selected={v.inspectorTab === 'effects'} onClick={() => setView({ inspectorTab: 'effects' })}>Effects</button>
    </div>
    {v.selection.length > 1 && <p>{v.selection.length} items selected; showing the first.</p>}
    {v.inspectorTab === 'properties' ? <><ItemHeader item={item} />{item.type === 'motionGraphic' && <GraphicFields key={item.id} item={item} />}{(SECTIONS[item.type] ?? []).map(s => <SectionShell key={sectionKey(s, item)} doc={doc} item={item} section={s} />)}{!SECTIONS[item.type] && <Unavailable what="The Properties sheet for this item type" owner={owners[item.type] ?? 'T04'} />}</>
      : <EffectsTab doc={doc} item={item} itemIds={v.selection} />}
  </section>;
}

// ---- Compact layout (part 3 §46.1, W3-ED-01): bottom tabs per selection state, each opening the bottom drawer.
export type CompactTab = { id: string; label: string };
export function compactTabs(item: RecordData | undefined): CompactTab[] {
  const list = (ids: string[]) => ids.map(label => ({ id: label.toLowerCase(), label }));
  if (!item) return list(['Uploads', 'Texts', 'Motion', 'Shapes', 'Captions', 'Effects']);
  if (item.type === 'video') return list(['Basic', 'Speed', 'Transform', 'Appearance', 'Mask', 'Shadow']);
  if (item.type === 'text') return list(['Preset', 'Text', 'Animation', 'Basic', 'Transform', 'Stroke', 'Shadow']);
  return list(['Properties']); // Every other selection's tab list is unrecorded (shape T06 and layout T07 keep this default).
}
const NOTHING_SELECTED: Record<string, [string, string]> = { motion: ['Motion graphics', 'T08'], shapes: ['Shapes', 'T06'], captions: ['Captions', 'T09'] };
const VIDEO_SECTIONS: Record<string, string> = { basic: 'Basic', speed: 'Speed & Time Remap', transform: 'Transform', appearance: 'Appearance', mask: 'Mask', shadow: 'Shadow' };
/** The drawer's content for one compact tab: Uploads = the Footage tab; a video tab = a sheet with only that section expanded. */
export function CompactSheet({ tab, item, projectId, doc }: { tab: string; item: RecordData | undefined; projectId: string; doc: ProjectDocument }) {
  if (!item) {
    if (tab === 'uploads') return <FootageTabs projectId={projectId} />;
    if (tab === 'effects') return <ToolPanel tool="effects" projectId={projectId} />;
    if (tab === 'motion') return <MotionGraphicsPanel />;
    if (tab === 'shapes') return <ShapesPanel />;
    if (tab === 'texts') return <TextPanel />;
    const [what, owner] = NOTHING_SELECTED[tab] ?? ['This panel', 'T02'];
    return <section className="tool-panel"><h3>{what}</h3><Unavailable what={`The ${what} panel`} owner={owner} /></section>;
  }
  if (item.type === 'video') {
    const title = VIDEO_SECTIONS[tab], sections = SECTIONS.video;
    return <section className="sheet"><ItemHeader item={item} />{sections.map(s => s.title === title ? <SectionShell key={s.title} doc={doc} item={item} section={s} open /> : null)}</section>;
  }
  if (item.type === 'text') {
    const map: Record<string, string> = { stroke: 'Font Stroke', shadow: 'Font Shadow' }, title = map[tab] ?? tab[0].toUpperCase() + tab.slice(1), section = SECTIONS.text.find(s => s.title === title);
    return <section className="sheet"><ItemHeader item={item} />{section ? <SectionShell doc={doc} item={item} section={section} open /> : null}</section>;
  }
  // Image, audio, motion graphic, shape and layout keep the single Properties tab (their tab lists are unrecorded); its sheet holds every section.
  if ((owners[item.type] === 'T04' || item.type === 'shape' || item.type === 'layout') && SECTIONS[item.type]) return <section className="sheet"><ItemHeader item={item} />{item.type === 'motionGraphic' && <GraphicFields key={item.id} item={item} open />}{SECTIONS[item.type].map(s => <SectionShell key={s.title} doc={doc} item={item} section={s} open />)}</section>;
  return <section className="sheet"><ItemHeader item={item} /><Unavailable what={`The ${TYPE_NAMES[item.type] ?? item.type} properties sheet`} owner={owners[item.type] ?? 'T04'} /></section>;
}
