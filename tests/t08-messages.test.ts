// SPDX-License-Identifier: AGPL-3.0-only
// T08 agent-path message texts and checks, written from "Xapp reference compares and facts (C).md" 1.4.
// Characters that matter: U+2014 (em dash) and U+2026 (ellipsis) are written literally below.
import { describe, expect, it } from 'vitest';
import { compileMotionGraphic, EXPORT_REFUSAL } from '../apps/web/src/mg/compiler';
import { validateSummary } from '../apps/web/src/mg/edits';

// agent-checks.ts lands separately; load it by variable path so the compiler and summary tests run before it exists.
const checksPath = '../apps/web/src/mg/agent-checks';
const checks: any = await import(/* @vite-ignore */ checksPath).catch(() => ({}));
const { MEDIA_REFUSALS, nativeMediaRefusal, assetIdRefusal, fontNames, fontWarnings, FONT_WARNING } = checks;

const VIDEO = 'compilation error: Native <video> elements are not supported. Use Remotion\'s <OffthreadVideo> with getAssetUrl() instead. Example: const url = getAssetUrl("video_1"); <OffthreadVideo src={url} />';
const IMG = 'compilation error: Native <img> elements are not supported. Use Remotion\'s <Img> with getAssetUrl() instead. Example: const url = getAssetUrl("image_1"); <Img src={url} />';
const AUDIO = 'compilation error: Native <audio> elements are not supported. Use Remotion\'s a Remotion component with getAssetUrl() instead. Example: const url = getAssetUrl("image_1"); <Img src={url} />';
const EXPORT_TEXT = 'Put every helper (constants, components, functions) above the exported component and end the code with it: `export const MyAnimation = () => { … };` must be the last statement, with nothing after it.';
const warn = (name: string) => `Font "${name}" is not in the font catalog — it will fall back to a system font when rendered (editor preview may differ from the export). Use a catalog font.`;
const PREFIX = 'getAssetUrl() takes a project asset\'s agentId. ';
const unknown = (id: string) => `'${id}' is not an asset attached to this project.`;

describe('MEDIA_REFUSALS', () => {
  it('holds the exact 1.4 agent texts, including the odd audio wording', () => {
    expect(MEDIA_REFUSALS).toEqual({ video: VIDEO, img: IMG, audio: AUDIO });
  });
});

describe('nativeMediaRefusal', () => {
  it('refuses <video src=…> with the video text', () => { expect(nativeMediaRefusal('const a = <video src={url} />;')).toBe(VIDEO); });
  it('refuses <img followed by a newline, a tab, a space or >', () => {
    expect(nativeMediaRefusal('<img\n src="a" />')).toBe(IMG);
    expect(nativeMediaRefusal('<img\tsrc="a" />')).toBe(IMG);
    expect(nativeMediaRefusal('<img src="a" />')).toBe(IMG);
    expect(nativeMediaRefusal('<img>')).toBe(IMG);
  });
  it('refuses <audio> with the audio text', () => {
    expect(nativeMediaRefusal('<audio>')).toBe(AUDIO);
    expect(nativeMediaRefusal('<audio controls />')).toBe(AUDIO);
  });
  it('does not catch <video/>, <Video>, <videoX>, <IMG , <image> or <img/>', () => {
    for (const code of ['<video/>', '<Video>', '<Video src={a} />', '<videoX>', '<IMG src="a" />', '<image>', '<img/>', '<audio/>']) expect(nativeMediaRefusal(code), code).toBeNull();
  });
  it('returns null for code without native media', () => { expect(nativeMediaRefusal('export const A = () => <div>img video audio</div>;')).toBeNull(); });
  it('the first match in source order wins', () => {
    expect(nativeMediaRefusal('<img src="a" /> <video src="b" />')).toBe(IMG);
    expect(nativeMediaRefusal('<video src="b" /> <img src="a" />')).toBe(VIDEO);
    expect(nativeMediaRefusal('<audio> <img > <video >')).toBe(AUDIO);
  });
  it('is a text check: a match inside a string or a comment is still refused', () => {
    expect(nativeMediaRefusal('const s = "<audio controls>";')).toBe(AUDIO);
    expect(nativeMediaRefusal('// <video src="x">\nconst a = 1;')).toBe(VIDEO);
    expect(nativeMediaRefusal('/* <img src="x"> */')).toBe(IMG);
  });
});

describe('assetIdRefusal', () => {
  const assets = [{ agentId: 'image_1', id: 'a3f1-internal-1' }, { agentId: 'video_1', id: 'b7c2-internal-2' }];
  it('returns null when every id is an agentId, or there is no getAssetUrl call', () => {
    expect(assetIdRefusal('getAssetUrl("image_1"); getAssetUrl(\'video_1\');', assets)).toBeNull();
    expect(assetIdRefusal('const a = 1;', assets)).toBeNull();
    expect(assetIdRefusal('getAssetUrl("anything")', [{ agentId: 'anything', id: 'x' }])).toBeNull();
  });
  it('stored case 15: an unknown id gives the full 1.4 string', () => {
    expect(assetIdRefusal('const u = getAssetUrl("g06-no-such-asset");', [])).toBe('getAssetUrl() takes a project asset\'s agentId. \'g06-no-such-asset\' is not an asset attached to this project.');
    expect(assetIdRefusal('const u = getAssetUrl(\'g06-no-such-asset\');', assets)).toBe(PREFIX + unknown('g06-no-such-asset'));
  });
  it('an id equal to an asset\'s internal id gets the use-the-agentId hint', () => {
    expect(assetIdRefusal('getAssetUrl("a3f1-internal-1")', assets)).toBe(PREFIX + '\'a3f1-internal-1\' is asset \'image_1\': use getAssetUrl(\'image_1\').');
  });
  it('mixed case: 2 unknown ids (one repeated) and 1 internal id, de-duplicated, in first-appearance order, one space between parts', () => {
    const code = 'getAssetUrl("nope"); getAssetUrl(\'b7c2-internal-2\'); getAssetUrl("nope"); getAssetUrl("image_1"); getAssetUrl(\'other\'); getAssetUrl("b7c2-internal-2");';
    expect(assetIdRefusal(code, assets)).toBe(PREFIX + unknown('nope') + ' ' + '\'b7c2-internal-2\' is asset \'video_1\': use getAssetUrl(\'video_1\').' + ' ' + unknown('other'));
  });
  it('every bad id is reported (not just the first)', () => {
    expect(assetIdRefusal('getAssetUrl("x"); getAssetUrl("y"); getAssetUrl("z");', assets)).toBe(PREFIX + unknown('x') + ' ' + unknown('y') + ' ' + unknown('z'));
  });
  it('template-literal and variable arguments are not checked', () => {
    expect(assetIdRefusal('getAssetUrl(`image_${n}`)', assets)).toBeNull();
    expect(assetIdRefusal('getAssetUrl(id); getAssetUrl(a + "b");', assets)).toBeNull();
    expect(assetIdRefusal('getAssetUrl(id); getAssetUrl("nope")', assets)).toBe(PREFIX + unknown('nope'));
  });
});

describe('fontNames', () => {
  it('takes the first family of a single-quoted list', () => { expect(fontNames('const s = { fontFamily: \'A, B\' };')).toEqual(['A']); });
  it('reads double-quoted, backtick and JSX forms', () => {
    expect(fontNames('({ fontFamily: "A" })')).toEqual(['A']);
    expect(fontNames('({ fontFamily: `A` })')).toEqual(['A']);
    expect(fontNames('<div fontFamily="A" />')).toEqual(['A']);
    expect(fontNames('<div fontFamily="A, B" />')).toEqual(['A']);
  });
  it('keeps a template expression as raw text', () => { expect(fontNames('({ fontFamily: `${font}` })')).toEqual(['${font}']); });
  it('strips quotes inside the value and trims', () => {
    expect(fontNames('({ fontFamily: "\'Open Sans\', serif" })')).toEqual(['Open Sans']);
    expect(fontNames('<div fontFamily="\'Open Sans\', serif" />')).toEqual(['Open Sans']);
    expect(fontNames('({ fontFamily: \'  A  , B\' })')).toEqual(['A']);
  });
  it('de-duplicates, in first-appearance order', () => { expect(fontNames('({ fontFamily: \'A\' }); ({ fontFamily: "B, C" }); ({ fontFamily: `A` })')).toEqual(['A', 'B']); });
  it('ignores non-literal values and code without fontFamily', () => {
    expect(fontNames('({ fontFamily: font })')).toEqual([]);
    expect(fontNames('({ color: "red" })')).toEqual([]);
  });
});

describe('FONT_WARNING and fontWarnings', () => {
  it('FONT_WARNING is the 1.4 text', () => {
    expect(FONT_WARNING('Montserrat')).toBe(warn('Montserrat'));
    expect(FONT_WARNING('${font}')).toBe('Font "${font}" is not in the font catalog — it will fall back to a system font when rendered (editor preview may differ from the export). Use a catalog font.');
  });
  it('Roboto is in the default catalogue, so a Roboto-first list gives no warning', () => {
    expect(fontWarnings('({ fontFamily: \'Roboto, Arial, sans-serif\' })')).toEqual([]);
    expect(fontWarnings('({ fontFamily: \'roboto\' })')).toEqual([]);
    expect(fontWarnings('({ fontFamily: \'ROBOTO\' })')).toEqual([]);
  });
  it('stored case 15: `${font}` warns naming the literal ${font}', () => { expect(fontWarnings('({ fontFamily: `${font}` })')).toEqual([warn('${font}')]); });
  it('an uncatalogued font warns', () => { expect(fontWarnings('({ fontFamily: \'Montserrat\' })')).toEqual([warn('Montserrat')]); });
  it('CSS generic families never warn, in any case', () => {
    for (const g of ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', 'inherit', 'initial', 'unset']) {
      expect(fontWarnings(`({ fontFamily: '${g}' })`), g).toEqual([]);
      expect(fontWarnings(`({ fontFamily: '${g.toUpperCase()}' })`), g.toUpperCase()).toEqual([]);
    }
  });
  it('one warning per distinct name, in source order', () => {
    expect(fontWarnings('({ fontFamily: "Montserrat" }); ({ fontFamily: "Lato, serif" }); ({ fontFamily: `Montserrat` }); ({ fontFamily: "Roboto" })')).toEqual([warn('Montserrat'), warn('Lato')]);
  });
  it('a quoted name is warned without its quotes', () => { expect(fontWarnings('({ fontFamily: "\'Open Sans\', serif" })')).toEqual([warn('Open Sans')]); });
  it('a custom catalogue (a Set of lowercase names) replaces the default, case-insensitively', () => {
    expect(fontWarnings('({ fontFamily: \'Montserrat\' })', new Set(['montserrat']))).toEqual([]);
    expect(fontWarnings('({ fontFamily: \'montserrat\' })', new Set(['montserrat']))).toEqual([]);
    expect(fontWarnings('({ fontFamily: \'Roboto\' })', new Set(['montserrat']))).toEqual([warn('Roboto')]);
  });
});

describe('compileMotionGraphic export refusal (R3)', () => {
  const refusal = (code: string) => { try { compileMotionGraphic(code); } catch (e) { return e as { code: string; message: string }; } throw new Error('expected a throw'); };
  it('EXPORT_REFUSAL is the exact R3 text without the prefix', () => { expect(EXPORT_REFUSAL).toBe(EXPORT_TEXT); });
  it('a helper after the export throws COMPILATION_ERROR with the compilation-error prefix', () => {
    const e = refusal('export const A = () => <div />;\nconst helper = 1;');
    expect(e.code).toBe('COMPILATION_ERROR');
    expect(e.message).toBe('compilation error: ' + EXPORT_TEXT);
  });
  it('export default gets the same refusal', () => {
    const e = refusal('export default () => <div />;');
    expect(e.code).toBe('COMPILATION_ERROR');
    expect(e.message).toBe('compilation error: ' + EXPORT_TEXT);
  });
  it('helpers above the export still compile', () => {
    expect(compileMotionGraphic('const helper = 1;\nexport const A = () => <div>{helper}</div>;').name).toBe('A');
  });
});

describe('validateSummary', () => {
  const REQUIRED = 'Motion graphic summary is required. Describe what the graphic visually represents in 1 sentence, or up to 3 short sentences for complex graphics.';
  const TOO_LONG = 'Motion graphic summary must be 400 characters or less.';
  it('blank or whitespace-only gives reason required and the full message', () => {
    for (const v of ['', '   ', ' \n\t ']) {
      const r = validateSummary(v);
      expect(r.valid, JSON.stringify(v)).toBe(false);
      expect(r.reason).toBe('required');
      expect(r.message).toBe(REQUIRED);
    }
  });
  it('401 characters after collapsing whitespace gives too-long', () => {
    for (const v of ['a'.repeat(401), 'a'.repeat(200) + '  \n ' + 'b'.repeat(200)]) {
      const r = validateSummary(v);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('too-long');
      expect(r.message).toBe(TOO_LONG);
    }
  });
  it('exactly 400 is valid, also when the raw text is longer before collapsing', () => {
    expect(validateSummary('a'.repeat(400))).toMatchObject({ valid: true, summary: 'a'.repeat(400) });
    const raw = 'a'.repeat(200) + '     \n   ' + 'b'.repeat(199);
    expect(raw.length).toBeGreaterThan(400);
    expect(validateSummary(raw)).toMatchObject({ valid: true, summary: 'a'.repeat(200) + ' ' + 'b'.repeat(199) });
  });
  it('trims and collapses whitespace runs to one space', () => { expect(validateSummary('  a \n\t b  ')).toMatchObject({ valid: true, summary: 'a b' }); });
});
