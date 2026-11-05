// SPDX-License-Identifier: AGPL-3.0-only
// T08 parity adapter, timeline mode: any tool other than mg.add / mg.patchCode runs on a real T03 timeline (createEditor over
// emptyDocument at the project size and fps), addMotionGraphic / editMotionGraphic through callMotionGraphicTool with the dry run
// in the page, every other name through editor.call. Real Vite and Chromium; one adapter per describe.
// Oracles: research "Xapp reference compares and facts (C)" §1.2 and §1.4 (add envelope, TRACK_OVERLAP, 16a trim and split, R3,
// FONT WARNING, asset ids), agent tool results §2, and t08-tools for the asset-check text. Only the id format and the "draws motion
// graphics only" throw come from the code.
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MotionGraphicParityAdapter } from '../apps/web/src/mg/adapter';

const W = 180, H = 320;
const EXPORT_REFUSAL = 'compilation error: Put every helper (constants, components, functions) above the exported component and end the code with it: `export const MyAnimation = () => { … };` must be the last statement, with nothing after it.';
const ASSET_PREFIX = "getAssetUrl() takes a project asset's agentId. ";
const FONT_WARNING = 'Font "Comic Neue" is not in the font catalog — it will fall back to a system font when rendered (editor preview may differ from the export). Use a catalog font.';
const BOX_CODE = "export const Box = () => { const f = useCurrentFrame(); return <AbsoluteFill style={{ backgroundColor: f < 45 ? '#ff0000' : '#0000ff', fontFamily: 'Comic Neue' }} />; };";
const box = (over: Record<string, unknown> = {}) => ({ code: BOX_CODE, summary: 'A red box.', width: 90, height: 160, x: 10, y: 20, trackId: 'track_000001', timelineStart: 0, duration: 4, ...over });
const EMPTY = { width: W, height: H, fps: 30, graphics: [] };

/** A w×h solid-colour PNG as a data URL (stored deflate via zlib, CRC32 by hand). */
function png(w: number, h: number, [r, g, b]: number[]): string {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const file = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${file.toString('base64')}`;
}

type Frame = { width: number; height: number; rgba: Float64Array };
const pixel = (f: Frame, x: number, y: number) => Array.from(f.rgba.slice((y * f.width + x) * 4, (y * f.width + x) * 4 + 4)).map(v => Math.round(v * 255));
/** Inclusive bounding box of every pixel with alpha > 0, or null when the frame is empty. */
function bbox(f: Frame) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (f.rgba[(y * f.width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}
const item = (doc: any, id: string) => doc.items.find((i: any) => i.id === id);

describe('MotionGraphicParityAdapter timeline mode: the smoke scenario (real Vite and Chromium)', () => {
  const adapter = new MotionGraphicParityAdapter();
  const r: any[] = [], docs: string[] = [];
  let before: any, afterMg: any;
  const steps: [string, any][] = [
    ['manageTrack', { action: 'create', kind: 'overlay' }],
    ['addMotionGraphic', box()],
    ['addMotionGraphic', box({ code: 'export const Box = () => <AbsoluteFill />;', summary: 'Overlap.', x: 0, y: 0, timelineStart: 2 })],
    ['addMotionGraphic', box({ code: 'export default () => <AbsoluteFill />;', summary: 'Default export.', x: 0, y: 0, timelineStart: 5, duration: 1 })],
    ['trimItem', { itemId: 'item_000002', handle: 'end', deltaSeconds: -1 }],
    ['splitItem', { itemId: 'item_000002', timestampS: 1.5 }],
    ['fooBar', {}],
  ];
  const frames: Record<number, Frame> = {};
  beforeAll(async () => {
    await adapter.open(EMPTY);
    before = await adapter.project();
    // An mg.add graphic is not a timeline tool: project() still has no document, and its own frame is drawn by the old path.
    expect(await adapter.execute('mg.add', { id: 'g', summary: 'A green fill.', code: "export const G = () => <AbsoluteFill style={{backgroundColor:'#00ff00'}} />;", startMs: 9000, durationMs: 1000 })).toEqual({ success: true });
    afterMg = await adapter.project();
    for (const [tool, input] of steps) { r.push(await adapter.execute(tool, input)); docs.push(JSON.stringify((await adapter.project() as any).document)); }
    for (const t of [0, 1000, 2000, 3500]) frames[t] = await adapter.frame(t) as Frame;
  }, 240_000);
  afterAll(async () => { await adapter.close(); }, 60_000);

  describe('a. every result', () => {
    it('manageTrack create overlay → success, data.track.id track_000001, name O1', () => {
      expect(r[0].success).toBe(true);
      expect(r[0].data.track).toMatchObject({ id: 'track_000001', name: 'O1' });
    });
    it("addMotionGraphic → the add envelope with the FONT WARNING suffix, data keys, timelineChanges", () => {
      expect(r[1]).toMatchObject({
        success: true,
        message: `Motion graphic 'item_000002' added to track 'track_000001' at 0s — FONT WARNING: ${FONT_WARNING}`,
        data: { itemId: 'item_000002', trackId: 'track_000001', duration: 4, timelineStart: 0, summary: 'A red box.', fontWarnings: [FONT_WARNING] },
      });
      expect(Object.keys(r[1].data).sort()).toEqual(['duration', 'fontWarnings', 'itemId', 'summary', 'timelineStart', 'trackId']);
      expect(r[1].timelineChanges).toBeDefined();
    });
    it('the same track at 2 s → TRACK_OVERLAP with the stored text (error only is not required: message may repeat it), and the id item_000003 is used up', () => {
      expect(r[2]).toMatchObject({ success: false, code: 'TRACK_OVERLAP', error: "Requested range overlaps item 'item_000002' (0s–4s) on track 'track_000001'. That track has room for this length from 4s." });
      expect(r[2].data).toBeUndefined();
    });
    it('export default → COMPILATION_ERROR, error and message both the R3 text; nothing added', () => {
      expect(r[3]).toMatchObject({ success: false, code: 'COMPILATION_ERROR', error: EXPORT_REFUSAL, message: EXPORT_REFUSAL });
      expect(r[3].timelineChanges).toBeUndefined();
    });
    it('both refusals leave the document byte-identical', () => {
      expect(docs[2]).toBe(docs[1]);
      expect(docs[3]).toBe(docs[2]);
      expect(docs[1]).not.toBe(docs[0]);
    });
    it('trimItem end -1 s → success, appliedDeltaSeconds -1', () => {
      expect(r[4].success).toBe(true);
      expect(r[4].data.appliedDeltaSeconds).toBe(-1);
      expect(item(JSON.parse(docs[4]), 'item_000002').display).toMatchObject({ from: 0, to: 3000 });
    });
    it('splitItem at 1.5 s → left item_000002, right item_000004 (item_000003 was spent on the refusal)', () => {
      expect(r[5].success).toBe(true);
      expect(JSON.stringify(r[5])).toContain('item_000004');
      const doc = JSON.parse(docs[5]);
      expect(item(doc, 'item_000002')).toMatchObject({ display: { from: 0, to: 1500 }, trim: { from: 0, to: 1500 } });
      expect(item(doc, 'item_000004')).toMatchObject({ display: { from: 1500, to: 3000 }, trim: { from: 1500, to: 3000 } });
      expect(doc.items.filter((i: any) => i.type === 'motionGraphic').map((i: any) => i.id).sort()).toEqual(['item_000002', 'item_000004']);
    });
    it('an unknown name → callTool UNKNOWN_TOOL "Unknown tool \'fooBar\'" (the old throw is gone), document unchanged', () => {
      expect(r[6]).toEqual({ success: false, error: "Unknown tool 'fooBar'", code: 'UNKNOWN_TOOL' });
      expect(docs[6]).toBe(docs[5]);
    });
    it('results are plain JSON (a round trip changes nothing)', () => { for (const x of r) expect(JSON.parse(JSON.stringify(x))).toEqual(x); });
  });

  describe('b. frames', () => {
    it.each([0, 1000])('%i ms: bbox 10,20–99,179 (x 10 y 20, 90×160 box), centre pixel red', t => {
      expect(frames[t].width).toBe(W); expect(frames[t].height).toBe(H);
      expect(bbox(frames[t])).toEqual({ x0: 10, y0: 20, x1: 99, y1: 179 });
      expect(pixel(frames[t], 55, 100)).toEqual([255, 0, 0, 255]);
    });
    it('2000 ms: same bbox, centre blue (the right piece is on the graphic clock: (2000 − 1500 + 1500) ms = frame 60 ≥ 45)', () => {
      expect(bbox(frames[2000])).toEqual({ x0: 10, y0: 20, x1: 99, y1: 179 });
      expect(pixel(frames[2000], 55, 100)).toEqual([0, 0, 255, 255]);
    });
    it('3500 ms: empty (both pieces end by 3000 ms)', () => {
      expect(bbox(frames[3500])).toBeNull();
    });
    it('pixels inside the box are solid and pixels outside are transparent', () => {
      for (const [x, y] of [[10, 20], [99, 179], [10, 179], [99, 20]]) expect(pixel(frames[0], x, y)).toEqual([255, 0, 0, 255]);
      for (const [x, y] of [[9, 20], [100, 20], [10, 19], [10, 180], [0, 0], [179, 319]]) expect(pixel(frames[0], x, y)[3], `(${x},${y})`).toBe(0);
    });
  });

  describe('d. project()', () => {
    it('has no document key after mg.add only; the graphics are there', () => {
      expect('document' in before).toBe(false);
      expect('document' in afterMg).toBe(false);
      expect(afterMg.graphics).toHaveLength(1);
    });
    it('has the live document once a timeline tool has run', async () => {
      const p = await adapter.project() as any;
      expect(p.document.size).toEqual({ width: W, height: H });
      expect(p.document.fps).toBe(30);
      expect(JSON.stringify(p.document)).toBe(docs[6]);
      expect(p.graphics).toHaveLength(1);
      expect(p.width).toBe(W);
    });
    it('is a copy: changing it does not change the timeline', async () => {
      const p = await adapter.project() as any; p.document.items.length = 0;
      expect(JSON.stringify((await adapter.project() as any).document)).toBe(docs[6]);
    });
  });
});

describe('MotionGraphicParityAdapter timeline mode: ids (e)', () => {
  it('restart at track_000001 in a second adapter after close(), and a closed adapter does not leak its counter', async () => {
    const run = async () => {
      const a = new MotionGraphicParityAdapter();
      await a.open(EMPTY);
      try {
        const track: any = await a.execute('manageTrack', { action: 'create', kind: 'overlay' });
        const add: any = await a.execute('addMotionGraphic', box({ code: 'export const Box = () => <AbsoluteFill />;', summary: 'A box.' }));
        return [track.data.track.id, add.data.itemId];
      } finally { await a.close(); }
    };
    expect(await run()).toEqual(['track_000001', 'item_000002']);
    expect(await run()).toEqual(['track_000001', 'item_000002']);
  }, 240_000);
});

describe('MotionGraphicParityAdapter timeline mode: project assets (c)', () => {
  const adapter = new MotionGraphicParityAdapter();
  const IMG = "export const Logo = () => <Img src={getAssetUrl('logo')} style={{width:'100%',height:'100%'}} />;";
  let added: any, missing: any, before = '', after = '', frame: Frame;
  beforeAll(async () => {
    await adapter.open({ ...EMPTY, assets: { logo: png(4, 4, [0, 255, 0]) } });
    await adapter.execute('manageTrack', { action: 'create', kind: 'overlay' });
    added = await adapter.execute('addMotionGraphic', box({ code: IMG, summary: 'A logo.', duration: 2 }));
    before = JSON.stringify((await adapter.project() as any).document);
    missing = await adapter.execute('addMotionGraphic', box({ code: "export const Logo = () => <Img src={getAssetUrl('nope')} />;", summary: 'A missing logo.', timelineStart: 3 }));
    after = JSON.stringify((await adapter.project() as any).document);
    frame = await adapter.frame(500) as Frame;
  }, 240_000);
  afterAll(async () => { await adapter.close(); }, 60_000);

  it('an asset attached by project.assets passes the add (the id is its agentId)', () => {
    expect(added).toMatchObject({ success: true, message: "Motion graphic 'item_000002' added to track 'track_000001' at 0s" });
  });
  it('getAssetUrl("logo") draws the green image inside the box and nothing outside it', () => {
    expect(bbox(frame)).toEqual({ x0: 10, y0: 20, x1: 99, y1: 179 });
    for (const [x, y] of [[55, 100], [12, 22], [97, 177]]) {
      const [rr, gg, bb, aa] = pixel(frame, x, y);
      expect([rr, gg, bb, aa], `(${x},${y})`).toEqual([0, 255, 0, 255]);
    }
  });
  it('getAssetUrl("nope") is refused on add with the asset-check text (VALIDATION_ERROR, error = message), nothing added', () => {
    const text = `${ASSET_PREFIX}'nope' is not an asset attached to this project.`;
    expect(missing).toMatchObject({ success: false, code: 'VALIDATION_ERROR', error: text, message: text });
    expect(after).toBe(before);
  });
});

describe('MotionGraphicParityAdapter timeline mode: editMotionGraphic (f)', () => {
  const adapter = new MotionGraphicParityAdapter();
  const GREEN = "export const Box = () => <AbsoluteFill style={{ backgroundColor: '#00ff00' }} />;";
  const THROWS = "export const Box = () => { throw new Error('boom at frame 0'); };";
  const out: Record<string, any> = {}, docs: Record<string, string> = {};
  const snap = async () => JSON.stringify((await adapter.project() as any).document);
  beforeAll(async () => {
    await adapter.open(EMPTY);
    await adapter.execute('manageTrack', { action: 'create', kind: 'overlay' });
    await adapter.execute('addMotionGraphic', box({ code: "export const Box = () => <AbsoluteFill style={{ backgroundColor: '#ff0000' }} />;", duration: 2 }));
    docs.start = await snap();
    out.view = await adapter.execute('editMotionGraphic', { itemId: 'item_000002' });
    out.update = await adapter.execute('editMotionGraphic', { itemId: 'item_000002', action: 'updateCode', code: GREEN });
    docs.update = await snap();
    out.green = await adapter.frame(0);
    out.patch = await adapter.execute('editMotionGraphic', { itemId: 'item_000002', action: 'patchCode', patches: [{ old_string: '#00ff00', new_string: '#0000ff' }] });
    docs.patch = await snap();
    out.blue = await adapter.frame(0);
    out.refused = await adapter.execute('editMotionGraphic', { itemId: 'item_000002', action: 'updateCode', code: THROWS });
    docs.refused = await snap();
    out.nopatches = await adapter.execute('editMotionGraphic', { itemId: 'item_000002', action: 'patchCode' });
    out.unknownItem = await adapter.execute('editMotionGraphic', { itemId: 'item_999999', action: 'updateCode', code: GREEN });
  }, 240_000);
  afterAll(async () => { await adapter.close(); }, 60_000);

  it('view returns the code and the summary', () => {
    expect(out.view).toMatchObject({ success: true, message: 'Motion graphic code retrieved', data: { agentId: 'item_000002', summary: 'A red box.' } });
    expect(out.view.data.code).toContain('#ff0000');
  });
  it('updateCode → "Motion graphic code updated", the code replaced, the stored summary kept', () => {
    expect(out.update).toMatchObject({ success: true, message: 'Motion graphic code updated', data: { agentId: 'item_000002', codeLength: GREEN.length, summary: 'A red box.' } });
    expect(out.update.timelineChanges).toBeDefined();
    expect(item(JSON.parse(docs.update), 'item_000002').details.code).toBe(GREEN);
    expect(docs.update).not.toBe(docs.start);
  });
  it('the edited code is what the next frame draws (green, then blue after the patch)', () => {
    expect(pixel(out.green, 55, 100)).toEqual([0, 255, 0, 255]);
    expect(out.patch).toMatchObject({ success: true, message: 'Motion graphic code patched' });
    expect(item(JSON.parse(docs.patch), 'item_000002').details.code).toBe(GREEN.replace('#00ff00', '#0000ff'));
    expect(pixel(out.blue, 55, 100)).toEqual([0, 0, 255, 255]);
  });
  it('a code that throws in the sandbox dry run → COMPILATION_ERROR "compilation error: …" (R4), error = message, document unchanged', () => {
    expect(out.refused).toMatchObject({ success: false, code: 'COMPILATION_ERROR' });
    expect(out.refused.error).toBe(out.refused.message);
    expect(out.refused.error.startsWith('compilation error: ')).toBe(true);
    expect(out.refused.error).toContain('boom at frame 0');
    expect(docs.refused).toBe(docs.patch);
  });
  it('the checks before the dry run are unchanged: no patches → MISSING_PARAM, an unknown item → ITEM_NOT_FOUND-style refusal', () => {
    expect(out.nopatches).toMatchObject({ success: false, code: 'MISSING_PARAM', error: 'Missing patches', message: "patchCode requires the 'patches' array" });
    expect(out.unknownItem.success).toBe(false);
    expect(typeof out.unknownItem.code).toBe('string');
  });
});

describe('MotionGraphicParityAdapter timeline mode: itemFrameOverrides (h)', () => {
  const adapter = new MotionGraphicParityAdapter();
  const second = { x: 100, y: 200, width: 60, height: 60 };
  const frames: Record<number, Frame> = {};
  beforeAll(async () => {
    // Ids: track_000001, item_000002, track_000003, item_000004. The override names item_000002 at 1000 ms only: graphic frame 50 (blue, ≥ 45).
    await adapter.open({ ...EMPTY, itemFrameOverrides: { item_000002: { '1000': 50 } } });
    await adapter.execute('manageTrack', { action: 'create', kind: 'overlay' });
    await adapter.execute('addMotionGraphic', box({ duration: 3 }));
    await adapter.execute('manageTrack', { action: 'create', kind: 'overlay' });
    await adapter.execute('addMotionGraphic', box({ ...second, trackId: 'track_000003', duration: 3 }));
    for (const t of [0, 1000, 2000, 3500]) frames[t] = await adapter.frame(t) as Frame;
  }, 240_000);
  afterAll(async () => { await adapter.close(); }, 60_000);

  it('the named item at the named time draws the override frame: 1000 ms is blue instead of red', () => {
    expect(pixel(frames[1000], 55, 100)).toEqual([0, 0, 255, 255]);
    expect(bbox(frames[1000])).toMatchObject({ x0: 10, y0: 20 });
  });
  it('other times are unchanged: 0 ms red, 2000 ms blue (its own clock, frame 60), 3500 ms empty', () => {
    expect(pixel(frames[0], 55, 100)).toEqual([255, 0, 0, 255]);
    expect(pixel(frames[2000], 55, 100)).toEqual([0, 0, 255, 255]);
    expect(bbox(frames[3500])).toBeNull();
  });
  it('a second graphic on another track keeps its own clock: red at 0 and 1000 ms, blue at 2000 ms', () => {
    const at = (t: number) => pixel(frames[t], 130, 230);
    expect(at(0)).toEqual([255, 0, 0, 255]);
    expect(at(1000)).toEqual([255, 0, 0, 255]);
    expect(at(2000)).toEqual([0, 0, 255, 255]);
    expect(bbox(frames[0])).toEqual({ x0: 10, y0: 20, x1: 159, y1: 259 });
  });
});

describe('MotionGraphicParityAdapter timeline mode: a mixed frame (i)', () => {
  const adapter = new MotionGraphicParityAdapter();
  let frame: Frame, late: Frame;
  beforeAll(async () => {
    await adapter.open(EMPTY);
    expect(await adapter.execute('mg.add', { id: 'g', summary: 'A green fill.', code: "export const G = () => <AbsoluteFill style={{backgroundColor:'#00ff00'}} />;" })).toEqual({ success: true });
    await adapter.execute('manageTrack', { action: 'create', kind: 'overlay' });
    await adapter.execute('addMotionGraphic', box({ duration: 3 }));
    frame = await adapter.frame(0) as Frame; late = await adapter.frame(3500) as Frame;
  }, 240_000);
  afterAll(async () => { await adapter.close(); }, 60_000);

  it('the mg.add graphic is drawn first and the timeline over it: green outside the box, red inside', () => {
    expect(pixel(frame, 150, 300)).toEqual([0, 255, 0, 255]);
    expect(pixel(frame, 55, 100)).toEqual([255, 0, 0, 255]);
    expect(pixel(frame, 0, 0)).toEqual([0, 255, 0, 255]);
  });
  it('the box edges are exact over the green layer', () => {
    for (const [x, y] of [[10, 20], [99, 179]]) expect(pixel(frame, x, y)).toEqual([255, 0, 0, 255]);
    for (const [x, y] of [[9, 20], [100, 179], [10, 19], [99, 180]]) expect(pixel(frame, x, y)).toEqual([0, 255, 0, 255]);
  });
  it('after the timeline item ends only the mg.add graphic is left (the green is not cleared)', () => {
    expect(bbox(late)).toEqual({ x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
    expect(pixel(late, 55, 100)).toEqual([0, 255, 0, 255]);
  });
});

describe('MotionGraphicParityAdapter timeline mode: a non-motion-graphic item (g)', () => {
  const adapter = new MotionGraphicParityAdapter();
  beforeAll(async () => { await adapter.open({ ...EMPTY, assets: { logo: png(4, 4, [0, 255, 0]) } }); }, 120_000);
  afterAll(async () => { await adapter.close(); }, 60_000);
  it('a placed image makes frame() throw "MG adapter draws motion graphics only; item <id> is not one."', async () => {
    await adapter.execute('manageTrack', { action: 'create', kind: 'video' });
    const placed: any = await adapter.execute('addMedia', { assetId: 'logo', trackId: 'track_000001', timelineStart: 0, duration: 2 });
    expect(placed.success, JSON.stringify(placed)).toBe(true);
    await expect(adapter.frame(500)).rejects.toThrow(/^MG adapter draws motion graphics only; item item_\d{6} is not one\.$/);
  }, 120_000);
});
