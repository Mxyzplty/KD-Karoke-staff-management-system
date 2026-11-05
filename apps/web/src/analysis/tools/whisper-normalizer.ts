// SPDX-License-Identifier: AGPL-3.0-only AND MIT
/*! @license EnglishTextNormalizer, EnglishNumberNormalizer, EnglishSpellingNormalizer and remove_symbols_and_diacritics:
 * a TypeScript port of https://github.com/openai/whisper @ 86098128c0b4f24f0e2aa2994de830614b474227, whisper/normalizers/english.py
 * and whisper/normalizers/basic.py. whisper-english-spelling.json is whisper/normalizers/english.json, byte for byte.
 *
 * MIT License
 *
 * Copyright (c) 2022 OpenAI
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/** Dev-only (T19q Q8, D31): the WER rows of score.ts. Ported whole; a difference from upstream's output is a bug. */
import spelling from './whisper-english-spelling.json';

// Python 3's \b, \s and \d on a str are Unicode-aware and JS's are not, so upstream's patterns are kept as written and
// rewritten here: \w is letters, numbers and _; \s is str.isspace(), which has U+001C-1F and U+0085 and lacks JS's U+FEFF;
// \d is Nd. Every pattern runs with the u flag, so it sees code points, as Python does.
const WORD = String.raw`[\p{L}\p{N}_]`, SPACE = String.raw`\t-\r\x1c-\x1f \x85\xa0  -     　`;
const PYTHON_CLASS: Record<string, string> = { '\\b': `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`, '\\s': `[${SPACE}]`, '\\S': `[^${SPACE}]`, '\\d': String.raw`\p{Nd}` };
const compile = (pattern: string, flags: string) => new RegExp(pattern.replace(/\\[bsSd]/g, c => PYTHON_CLASS[c]), flags);
const py = ({ raw }: TemplateStringsArray) => compile(raw[0], 'gu');
/** str.split() */
const splitWords = (s: string) => s.match(py`\S+`) ?? [];

// basic.py: non-ASCII letters that are not separated by "NFKD" normalization
const ADDITIONAL_DIACRITICS = new Map([['œ', 'oe'], ['Œ', 'OE'], ['ø', 'o'], ['Ø', 'O'], ['æ', 'ae'], ['Æ', 'AE'], ['ß', 'ss'], ['ẞ', 'SS'], ['đ', 'd'], ['Đ', 'D'], ['ð', 'd'], ['Ð', 'D'], ['þ', 'th'], ['Þ', 'th'], ['ł', 'l'], ['Ł', 'L']]);
/** remove_symbols_and_diacritics(s, keep=".%$¢€£"), the one `keep` upstream's English normaliser passes. */
function removeSymbolsAndDiacritics(s: string) {
  let result = '';
  for (const c of s.normalize('NFKD')) result += '.%$¢€£'.includes(c) ? c : ADDITIONAL_DIACRITICS.get(c) ?? (/\p{Mn}/u.test(c) ? '' : /[\p{M}\p{S}\p{P}]/u.test(c) ? ' ' : c);
  return result;
}

// EnglishNumberNormalizer. Its self.literal_words is never read upstream.
type Suffixed<V> = readonly [V, string];
const suffixed = <V>(table: Map<string, V>, rename: (name: string) => string, suffix: string) => [...table].map(([name, value]): [string, Suffixed<V>] => [rename(name), [value, suffix]]);
const ZEROS = new Set(['o', 'oh', 'zero']);
const ONES = new Map(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'].map((name, i) => [name, i + 1]));
const ONES_ORDINAL: [string, Suffixed<number>][] = [['zeroth', [0, 'th']], ['first', [1, 'st']], ['second', [2, 'nd']], ['third', [3, 'rd']], ['fifth', [5, 'th']], ['twelfth', [12, 'th']],
  ...suffixed(new Map([...ONES].filter(([, value]) => value > 3 && value !== 5 && value !== 12)), name => name + (name.endsWith('t') ? 'h' : 'th'), 'th')];
const ONES_SUFFIXED = new Map([...suffixed(ONES, name => name === 'six' ? 'sixes' : name + 's', 's'), ...ONES_ORDINAL]);
const TENS = new Map([['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50], ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90]]);
const TENS_SUFFIXED = new Map([...suffixed(TENS, name => name.replaceAll('y', 'ies'), 's'), ...suffixed(TENS, name => name.replaceAll('y', 'ieth'), 'th')]);
// Up to 10^33, so every integer value here is a BigInt, as Python's ints are arbitrary precision.
const MULTIPLIERS = new Map([['hundred', 100n], ['thousand', 1_000n], ['million', 1_000_000n], ['billion', 1_000_000_000n], ['trillion', 1_000_000_000_000n], ['quadrillion', 1_000_000_000_000_000n], ['quintillion', 1_000_000_000_000_000_000n], ['sextillion', 1_000_000_000_000_000_000_000n], ['septillion', 1_000_000_000_000_000_000_000_000n], ['octillion', 1_000_000_000_000_000_000_000_000_000n], ['nonillion', 1_000_000_000_000_000_000_000_000_000_000n], ['decillion', 1_000_000_000_000_000_000_000_000_000_000_000n]]);
const MULTIPLIERS_SUFFIXED = new Map([...suffixed(MULTIPLIERS, name => name + 's', 's'), ...suffixed(MULTIPLIERS, name => name + 'th', 'th')]);
const DECIMALS = new Set([...ONES.keys(), ...TENS.keys(), ...ZEROS]);
const PRECEDING_PREFIXERS = new Map([['minus', '-'], ['negative', '-'], ['plus', '+'], ['positive', '+']]);
const FOLLOWING_PREFIXERS = new Map([['pound', '£'], ['pounds', '£'], ['euro', '€'], ['euros', '€'], ['dollar', '$'], ['dollars', '$'], ['cent', '¢'], ['cents', '¢']]);
const PREFIXES = new Set([...PRECEDING_PREFIXERS.values(), ...FOLLOWING_PREFIXERS.values()]);
const SUFFIXERS = new Map<string, string | Map<string, string>>([['per', new Map([['cent', '%']])], ['percent', '%']]);
const SPECIALS = new Set(['and', 'double', 'triple', 'point']);
const WORDS = new Set([...ZEROS, ...ONES.keys(), ...ONES_SUFFIXED.keys(), ...TENS.keys(), ...TENS_SUFFIXED.keys(), ...MULTIPLIERS.keys(), ...MULTIPLIERS_SUFFIXED.keys(), ...PRECEDING_PREFIXERS.keys(), ...FOLLOWING_PREFIXERS.keys(), ...SUFFIXERS.keys(), ...SPECIALS]);

const NUMERIC = compile(String.raw`^\d+(\.\d+)?$`, 'u'), DIGIT = compile(String.raw`\d`, 'u'), FRACTION = compile(String.raw`^(?=\d|\.\d)(\d*)(?:\.(\d*))?$`, 'u');
/** int(s) over any Nd digits. Nd digits come in contiguous runs of 0-9, so a digit's value is its offset from its run's start. */
function integer(s: string) {
  const digit = (c: string) => { const code = c.codePointAt(0)!; let start = code; while (DIGIT.test(String.fromCodePoint(start - 1))) start--; return (code - start) % 10; };
  return BigInt([...s].map(digit).join(''));
}
/** `Fraction(value) * multiplier` when it is a whole number; null when `value` is not a fraction or the denominator is not 1.
 * A str `value` only ever holds digits, '.' and pasted prefix symbols, so Fraction's signs, `/`, `_`, exponents and spaces
 * cannot occur. */
function wholeProduct(value: string | bigint, multiplier: bigint) {
  if (typeof value === 'bigint') return value * multiplier;
  const match = FRACTION.exec(value);
  if (!match) return null;
  const [, whole, decimals = ''] = match, scale = 10n ** BigInt(decimals.length), product = integer(whole + decimals) * multiplier;
  return product % scale === 0n ? product / scale : null;
}
/** `value % modulus == 0` adds, anything else concatenates. */
const extended = (value: bigint, n: number, modulus: bigint) => value % modulus === 0n ? value + BigInt(n) : String(value) + n;
const withOnes = (value: string | bigint, ones: number, prev: string) => {
  if (typeof value !== 'string' && !ONES.has(prev)) return extended(value, ones, ones < 10 ? 10n : 100n);
  if (!(TENS.has(prev) && ones < 10)) return String(value) + ones;
  const text = String(value); // replace the last zero with the digit
  if (text.at(-1) !== '0') throw Error(`Assertion failed: ${text}`);
  return text.slice(0, -1) + ones;
};
const withTens = (value: string | bigint, tens: number) => typeof value === 'string' ? value + tens : extended(value, tens, 100n);
/** A residual below 1000 is what a multiplier scales. */
const multiplied = (value: bigint, multiplier: bigint) => value / 1000n * 1000n + value % 1000n * multiplier;

function processWords(words: string[]) {
  const results: string[] = [];
  let prefix: string | null = null, value: string | bigint | null = null, skip = false;
  const emit = (result: string | bigint) => {
    results.push(prefix === null ? String(result) : prefix + result);
    value = null; prefix = null;
  };
  const flush = () => { if (value !== null) emit(value); };
  for (let i = 0; i < words.length; i++) {
    if (skip) { skip = false; continue; }
    // windowed([None] + words + [None], 3): None is in no table, and neither is ''. Python's truthy `next_is_numeric` holds a Match.
    const current = words[i], prev = words[i - 1] ?? '', next = words[i + 1] ?? '';
    const nextIsNumeric = NUMERIC.test(next), hasPrefix = PREFIXES.has(current[0]), withoutPrefix = hasPrefix ? current.slice(1) : current;
    if (NUMERIC.test(withoutPrefix)) {
      // arabic numbers (potentially with signs and fractions)
      const whole = wholeProduct(withoutPrefix, 1n);
      if (value !== null) {
        if (typeof value === 'string' && value.endsWith('.')) { value += current; continue; } // concatenate decimals / ip address components
        flush();
      }
      prefix = hasPrefix ? current[0] : prefix;
      value = whole ?? withoutPrefix; // store integers as BigInt
    } else if (!WORDS.has(current)) {
      // non-numeric words
      flush(); emit(current);
    } else if (ZEROS.has(current)) value = pyOr(value) + '0';
    else if (ONES.has(current)) {
      const ones = ONES.get(current)!;
      value = value === null ? BigInt(ones) : withOnes(value, ones, prev);
    } else if (ONES_SUFFIXED.has(current)) {
      // ordinal or cardinal; yield the number right away
      const [ones, suffix] = ONES_SUFFIXED.get(current)!;
      emit((value === null ? String(ones) : String(withOnes(value, ones, prev))) + suffix);
    } else if (TENS.has(current)) {
      const tens = TENS.get(current)!;
      value = value === null ? BigInt(tens) : withTens(value, tens);
    } else if (TENS_SUFFIXED.has(current)) {
      // ordinal or cardinal; yield the number right away
      const [tens, suffix] = TENS_SUFFIXED.get(current)!;
      emit((value === null ? String(tens) : String(withTens(value, tens))) + suffix);
    } else if (MULTIPLIERS.has(current)) {
      const multiplier = MULTIPLIERS.get(current)!;
      if (value === null) value = multiplier;
      else if (typeof value === 'string' || value === 0n) {
        const product = wholeProduct(value, multiplier);
        if (product !== null) value = product;
        else { flush(); value = multiplier; }
      } else value = multiplied(value, multiplier);
    } else if (MULTIPLIERS_SUFFIXED.has(current)) {
      const [multiplier, suffix] = MULTIPLIERS_SUFFIXED.get(current)!;
      if (value === null) emit(multiplier + suffix);
      else if (typeof value === 'string') {
        const product = wholeProduct(value, multiplier);
        if (product !== null) emit(product + suffix);
        else { flush(); emit(multiplier + suffix); }
      } else emit(multiplied(value, multiplier) + suffix);
    } else if (PRECEDING_PREFIXERS.has(current)) {
      // apply prefix (positive, minus, etc.) if it precedes a number
      flush();
      if (WORDS.has(next) || nextIsNumeric) prefix = PRECEDING_PREFIXERS.get(current)!;
      else emit(current);
    } else if (FOLLOWING_PREFIXERS.has(current)) {
      // apply prefix (dollars, cents, etc.) only after a number
      if (value !== null) { prefix = FOLLOWING_PREFIXERS.get(current)!; flush(); }
      else emit(current);
    } else if (SUFFIXERS.has(current)) {
      // apply suffix symbols (percent -> '%')
      if (value !== null) {
        const suffix = SUFFIXERS.get(current)!;
        if (typeof suffix === 'string') emit(String(value) + suffix);
        else if (suffix.has(next)) { emit(String(value) + suffix.get(next)); skip = true; }
        else { flush(); emit(current); }
      } else emit(current);
    } else if (SPECIALS.has(current)) {
      if (!WORDS.has(next) && !nextIsNumeric) {
        // apply special handling only if the next word can be numeric
        flush(); emit(current);
      } else if (current === 'and') {
        // ignore "and" after hundreds, thousands, etc.
        if (!MULTIPLIERS.has(prev)) { flush(); emit(current); }
      } else if (current === 'double' || current === 'triple') {
        if (ONES.has(next) || ZEROS.has(next)) {
          value = pyOr(value) + String(ONES.get(next) ?? 0).repeat(current === 'double' ? 2 : 3);
          skip = true;
        } else { flush(); emit(current); }
      } else if (current === 'point') {
        if (DECIMALS.has(next) || nextIsNumeric) value = pyOr(value) + '.';
      } else throw Error(`Unexpected token: ${current}`);
    } else throw Error(`Unexpected token: ${current}`);
  }
  flush();
  return results;
}
/** str(value or ""): the int 0 is falsy, as is ''. */
const pyOr = (value: string | bigint | null) => value === null || value === '' || value === 0n ? '' : String(value);

function preprocess(s: string) {
  // replace "<number> and a half" with "<number> point five"
  const results: string[] = [], segments = s.split(py`\band\s+a\s+half\b`);
  for (const [i, segment] of segments.entries()) {
    const words = splitWords(segment);
    if (!words.length) continue;
    results.push(segment);
    if (i === segments.length - 1) continue;
    const lastWord = words.at(-1)!;
    results.push(DECIMALS.has(lastWord) || MULTIPLIERS.has(lastWord) ? 'point five' : 'and a half');
  }
  s = results.join(' ');
  // put a space at number/letter boundary
  s = s.replace(py`([a-z])([0-9])`, '$1 $2');
  s = s.replace(py`([0-9])([a-z])`, '$1 $2');
  // but remove spaces which could be a suffix
  return s.replace(py`([0-9])\s+(st|nd|rd|th|s)\b`, '$1$2');
}
function postprocess(s: string) {
  // apply currency postprocessing; "$2 and ¢7" -> "$2.07". int() cannot raise on [0-9]{1,2}, so upstream's ValueError arms never run.
  s = s.replace(py`([€£$])([0-9]+) (?:and )?¢([0-9]{1,2})\b`, (_, currency: string, whole: string, cents: string) => `${currency}${whole}.${String(Number(cents)).padStart(2, '0')}`);
  // The '.' is upstream's unescaped any-character (no newline), and JS's '.' also refuses \r and U+2028-9.
  s = s.replace(py`[€£$]0[^\n]([0-9]{1,2})\b`, (_, cents: string) => `¢${Number(cents)}`);
  // write "one(s)" instead of "1(s)", just for the readability; only when it stands alone
  return s.replace(py`(?<!\S)1(s?)(?!\S)`, 'one$1');
}
/** EnglishNumberNormalizer.__call__ */
export function normalizeNumbers(s: string) { return postprocess(processWords(splitWords(preprocess(s))).join(' ')); }

// A Map, because `constructor` and friends would be found on a plain object.
const SPELLING = new Map(Object.entries(spelling as Record<string, string>));
/** EnglishSpellingNormalizer.__call__ */
export function normalizeSpelling(s: string) { return splitWords(s).map(word => SPELLING.get(word) ?? word).join(' '); }

// EnglishTextNormalizer, in upstream's replacer order.
const REPLACERS: [RegExp, string][] = [
  // common contractions
  [py`\bwon't\b`, 'will not'], [py`\bcan't\b`, 'can not'], [py`\blet's\b`, 'let us'], [py`\bain't\b`, 'aint'], [py`\by'all\b`, 'you all'],
  [py`\bwanna\b`, 'want to'], [py`\bgotta\b`, 'got to'], [py`\bgonna\b`, 'going to'], [py`\bi'ma\b`, 'i am going to'], [py`\bimma\b`, 'i am going to'],
  [py`\bwoulda\b`, 'would have'], [py`\bcoulda\b`, 'could have'], [py`\bshoulda\b`, 'should have'], [py`\bma'am\b`, 'madam'],
  // contractions in titles/prefixes
  [py`\bmr\b`, 'mister '], [py`\bmrs\b`, 'missus '], [py`\bst\b`, 'saint '], [py`\bdr\b`, 'doctor '], [py`\bprof\b`, 'professor '], [py`\bcapt\b`, 'captain '],
  [py`\bgov\b`, 'governor '], [py`\bald\b`, 'alderman '], [py`\bgen\b`, 'general '], [py`\bsen\b`, 'senator '], [py`\brep\b`, 'representative '],
  [py`\bpres\b`, 'president '], [py`\brev\b`, 'reverend '], [py`\bhon\b`, 'honorable '], [py`\basst\b`, 'assistant '], [py`\bassoc\b`, 'associate '],
  [py`\blt\b`, 'lieutenant '], [py`\bcol\b`, 'colonel '], [py`\bjr\b`, 'junior '], [py`\bsr\b`, 'senior '], [py`\besq\b`, 'esquire '],
  // prefect tenses, ideally it should be any past participles, but it's harder..
  [py`'d been\b`, ' had been'], [py`'s been\b`, ' has been'], [py`'d gone\b`, ' had gone'], [py`'s gone\b`, ' has gone'], [py`'d done\b`, ' had done'], [py`'s got\b`, ' has got'],
  // general contractions
  [py`n't\b`, ' not'], [py`'re\b`, ' are'], [py`'s\b`, ' is'], [py`'d\b`, ' would'], [py`'ll\b`, ' will'], [py`'t\b`, ' not'], [py`'ve\b`, ' have'], [py`'m\b`, ' am'],
];
/** EnglishTextNormalizer.__call__. Like upstream, the result can start or end with one space. */
export function normalizeEnglish(s: string) {
  s = s.toLowerCase();
  s = s.replace(py`[<\[][^>\]]*[>\]]`, ''); // remove words between brackets
  s = s.replace(py`\(([^)]+?)\)`, ''); // remove words between parenthesis
  s = s.replace(py`\b(hmm|mm|mhm|mmm|uh|um)\b`, '');
  s = s.replace(py`\s+'`, "'"); // when there's a space before an apostrophe
  for (const [pattern, replacement] of REPLACERS) s = s.replace(pattern, replacement);
  s = s.replace(py`(\d),(\d)`, '$1$2'); // remove commas between digits
  s = s.replace(py`\.([^0-9]|$)`, ' $1'); // remove periods not followed by numbers
  s = removeSymbolsAndDiacritics(s); // keep numeric symbols
  s = normalizeNumbers(s);
  s = normalizeSpelling(s);
  // now remove prefix/suffix symbols that are not preceded/followed by numbers
  s = s.replace(py`[.$¢€£]([^0-9])`, ' $1');
  s = s.replace(py`([^0-9])%`, '$1 ');
  return s.replace(py`\s+`, ' '); // replace any successive whitespaces with a space
}
