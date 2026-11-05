// SPDX-License-Identifier: AGPL-3.0-only
// T19q Q8 (D31): the Whisper EnglishTextNormalizer port (apps/web/src/analysis/tools/whisper-normalizer.ts) against openai/whisper
// @ 86098128's own tests (whisper/normalizers tests/test_normalizer.py, copied assertion for assertion) and against upstream's
// output on synthetic sentences (tests/fixtures/whisper-normalizer.json, from apps/web/src/analysis/tools/whisper_normalizer_ref.py).
// Synthetic data only; no model.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeEnglish, normalizeNumbers, normalizeSpelling } from '../apps/web/src/analysis/tools/whisper-normalizer';

// test_number_normalizer is parametrised over EnglishNumberNormalizer() and EnglishTextNormalizer().
describe.each([['normalizeNumbers', normalizeNumbers], ['normalizeEnglish', normalizeEnglish]])('upstream test_number_normalizer: %s', (_, std) => {
  it('passes every assertion', () => {
    expect(std("two")).toBe("2");
    expect(std("thirty one")).toBe("31");
    expect(std("five twenty four")).toBe("524");
    expect(std("nineteen ninety nine")).toBe("1999");
    expect(std("twenty nineteen")).toBe("2019");

    expect(std("two point five million")).toBe("2500000");
    expect(std("four point two billions")).toBe("4200000000s");
    expect(std("200 thousand")).toBe("200000");
    expect(std("200 thousand dollars")).toBe("$200000");
    expect(std("$20 million")).toBe("$20000000");
    expect(std("€52.4 million")).toBe("€52400000");
    expect(std("£77 thousands")).toBe("£77000s");

    expect(std("two double o eight")).toBe("2008");

    expect(std("three thousand twenty nine")).toBe("3029");
    expect(std("forty three thousand two hundred sixty")).toBe("43260");
    expect(std("forty three thousand two hundred and sixty")).toBe("43260");

    expect(std("nineteen fifties")).toBe("1950s");
    expect(std("thirty first")).toBe("31st");
    expect(std("thirty three thousand and three hundred and thirty third")).toBe("33333rd");

    expect(std("three billion")).toBe("3000000000");
    expect(std("millions")).toBe("1000000s");

    expect(std("july third twenty twenty")).toBe("july 3rd 2020");
    expect(std("august twenty sixth twenty twenty one")).toBe("august 26th 2021");
    expect(std("3 14")).toBe("3 14");
    expect(std("3.14")).toBe("3.14");
    expect(std("3 point 2")).toBe("3.2");
    expect(std("3 point 14")).toBe("3.14");
    expect(std("3 point 1")).toBe("3.1");
    expect(std("fourteen point 4")).toBe("14.4");
    expect(std("one point five")).toBe("1.5");
    expect(std("two point two five dollars")).toBe("$2.25");
    expect(std("two hundred million dollars")).toBe("$200000000");
    expect(std("$20.1 million")).toBe("$20100000");

    expect(std("ninety percent")).toBe("90%");
    expect(std("seventy six per cent")).toBe("76%");
    expect(std("one percent")).toBe("1%");

    expect(std("double oh seven")).toBe("007");
    expect(std("double zero seven")).toBe("007");
    expect(std("nine one one")).toBe("911");
    expect(std("nine double one")).toBe("911");
    expect(std("one triple oh one")).toBe("10001");

    expect(std("two thousandth")).toBe("2000th");
    expect(std("thirty two thousandth")).toBe("32000th");

    expect(std("minus 500")).toBe("-500");
    expect(std("positive twenty thousand")).toBe("+20000");
    expect(std("minus one")).toBe("-1");

    expect(std("two dollars and seventy cents")).toBe("$2.70");
    expect(std("3 cents")).toBe("¢3");
    expect(std("$0.36")).toBe("¢36");
    expect(std("three euros and sixty five cents")).toBe("€3.65");
    expect(std("one dollar and one cent")).toBe("$1.01");

    expect(std("three and a half million")).toBe("3500000");
    expect(std("forty eight and a half dollars")).toBe("$48.5");
    expect(std("b747")).toBe("b 747");
    expect(std("10 th")).toBe("10th");
    expect(std("10th")).toBe("10th");

    expect(std("one")).toBe("one");
    expect(std("ones")).toBe("ones");
  });
});

describe('upstream test_spelling_normalizer', () => {
  it('passes every assertion', () => {
    const std = normalizeSpelling;

    expect(std("mobilisation")).toBe("mobilization");
    expect(std("cancelation")).toBe("cancellation");
  });
});

describe('upstream test_text_normalizer', () => {
  it('passes every assertion', () => {
    const std = normalizeEnglish;
    expect(std("Let's")).toBe("let us");
    expect(std("he's like")).toBe("he is like");
    expect(std("she's been like")).toBe("she has been like");
    expect(std("10km")).toBe("10 km");
    expect(std("10mm")).toBe("10 mm");
    expect(std("RC232")).toBe("rc 232");

    expect(std("Mr. Park visited Assoc. Prof. Kim Jr.")).toBe("mister park visited associate professor kim junior");
  });
});

describe('normalizeEnglish against upstream output on synthetic sentences', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/whisper-normalizer.json', import.meta.url), 'utf8')) as
    { upstream: string; python: string; unicodedata: string; cases: [string, string][] };

  it('was generated from the pinned upstream commit', () => {
    expect(fixture.upstream).toBe('openai/whisper@86098128c0b4f24f0e2aa2994de830614b474227');
  });
  it('has at least 200 cases, with the empty string and the prototype names among them', () => {
    const inputs = fixture.cases.map(([input]) => input);
    expect(inputs.length).toBeGreaterThanOrEqual(200);
    expect(new Set(inputs).size).toBe(inputs.length);
    for (const input of ['', 'constructor', '__proto__', '$0x12', '0 oh', '٣.٠', '\u0085', '\u001c', '﻿', ' ']) expect(inputs).toContain(input);
  });
  // One assertion for the whole list, so a failure prints every disagreement and not just the first.
  it('returns upstream’s output for every case', () => {
    const wrong = fixture.cases.flatMap(([input, expected]) => { const actual = normalizeEnglish(input); return actual === expected ? [] : [{ input, expected, actual }]; });
    expect(wrong).toEqual([]);
  });
});

describe('normalizeSpelling', () => {
  it('uses whisper-english-spelling.json, byte for byte upstream’s english.json', () => {
    const bytes = readFileSync(new URL('../apps/web/src/analysis/tools/whisper-english-spelling.json', import.meta.url));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); // git hash-object
    expect(blob).toBe('74a1c3521d9af4a84a0aa65d95b0859138640799');
  });
  it('does not resolve Object.prototype names from a prototype', () => {
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) expect(normalizeSpelling(word)).toBe(word);
    expect(normalizeSpelling('constructor colour __proto__')).toBe('constructor color __proto__');
    expect(normalizeEnglish('The Constructor of __PROTO__')).toBe('the constructor of proto');
  });
});
