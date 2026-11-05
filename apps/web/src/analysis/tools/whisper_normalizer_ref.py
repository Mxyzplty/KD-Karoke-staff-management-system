# SPDX-License-Identifier: AGPL-3.0-only
"""Dev-only generator of tests/fixtures/whisper-normalizer.json (T19q Q8, D31): upstream's EnglishTextNormalizer output for
synthetic sentences, the reference that tests/whisper-normalizer.test.ts holds `normalizeEnglish` (whisper-normalizer.ts) to.

openai/whisper @ 86098128c0b4f24f0e2aa2994de830614b474227, whisper/normalizers/english.py with basic.py and english.json.
The first argument is a folder holding those three files byte for byte (english.py does `from .basic import ...`, so it is
loaded as a package without an __init__.py); it needs more_itertools and regex installed. The second is the fixture to write.

Run from the repo root with a python that has both, whichever shell:
  python -I apps/web/src/analysis/tools/whisper_normalizer_ref.py <folder with english.py, basic.py, english.json> tests/fixtures/whisper-normalizer.json
The fixture is written from Python itself, as UTF-8 with LF line ends and no BOM (ensure_ascii, so it is pure ASCII too),
and never through a shell redirect: PowerShell 5.1's `>` writes UTF-16.

Every input is synthetic and written below. An input on which upstream raises stops the run: the port has to agree with
upstream on what it returns, and a raising input has no output to compare.
"""
import importlib
import json
import platform
import sys
import types
import unicodedata

SHA = "86098128c0b4f24f0e2aa2994de830614b474227"

# --- English number words and their arithmetic (process_words, one branch each; the commented ones need a specific state)
NUMBERS = [
    "zero", "oh", "o", "one oh one", "oh oh", "zero zero seven", "o o o", "nine nine nine", "a hundred", "one hundred and one",
    "one hundred one", "hundred twenty", "two hundred thirty four", "twelve", "nineteen", "twenty", "twenty one", "twenty twenty",
    "ninety nine", "one thousand nine hundred ninety nine", "two thousand and five", "five hundred thousand",
    "three hundred and sixty five days", "one million two hundred thousand", "twelve hundred", "fifteen hundred dollars",
    "two million five hundred thousand", "one point five", "zero point five", "point five", "point oh five", "nought",
    "twenty five percent", "one two three four five", "ten eleven twelve", "twenty thirty forty", "twenty one twenty two",
    "five ten", "ten five", "forty five sixty", "twenty hundred thousand", "hundred hundred", "million million",
    "one million million", "one hundred and",
    # ones: str value, prev in tens, int value with and without a remainder
    "3.5 two", "3.5 twenty one", "point twenty three", "point thirteen", "23 three", "5 three", "10 three", "23 eleven", "20 eleven",
    "100 eleven", "twenty three", "thirty nine", "twenty o five", "0 oh", "zero oh", "oh zero",
    # ones_suffixed
    "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth",
    "thirteenth", "nineteenth", "zeroth", "ones", "twos", "sixes", "tens", "twenties", "thirties", "ninetieth", "twentieth",
    "hundreds", "thousands", "millionth", "hundredth", "thousandth", "twenty first", "twenty second", "twenty third",
    "thirty fifth", "forty fourth", "one hundred first", "hundred eleventh", "one hundred twelfth", "two thousand twenty first",
    "nineteen eighties", "nineteen sixties and seventies", "the nineties", "in the twenty twenties", "23 third", "23 eleventh",
    "100 eleventh", "3.5 third", "3.5 twentieth", "3.5 eleventh", "twenty one second", "twenty one eleventh", "point twenty third",
    "point twenty fourth", "twenty twentieth", "five twentieth", "twenty fifth", "ten seventh", "twelve twelfth",
    # tens with a str, a round and an unround value; tens_suffixed likewise
    "3.5 twenty", "100 twenty", "23 twenty", "3.5 twentieth", "100 twentieth", "23 twentieth", "two hundred twenty", "two twenty",
    # multipliers: nothing, str and whole, 0, str and not whole, int
    "3.5 hundred", "0 hundred", "0 million dollars", "zero hundred dollars", "3.14159 hundred", "3.14159 million",
    "1 point 2 point 3 hundred", "1.2.3 hundred", "twenty one hundred", "twenty one thousand", "three thousand",
    "two thousand twenty three", "one hundred thousand", "one hundred and fifty thousand", "five thousand five hundred",
    "3 million", "5000 thousand", "2 point million", "two point million", "two point five million dollars",
    # multipliers_suffixed: str whole, str not whole, int
    "3.5 thousands", "3.14159 hundredth", "3.14159 hundreds", "3.14159 hundredths", "1 point 2 point 3 hundredth",
    "1 point 2 point 3 hundreds", "two thousandth", "two hundred thousandth", "four point two billions", "3 millionth",
    # beyond 2^53
    "decillion", "one decillion", "ninety nine decillion", "nine hundred ninety nine nonillion", "nine nine nine decillion",
    "ten decillion thousand", "three decillions", "three decillionth", "two septillion five hundred octillion",
    "9007199254740993", "9007199254740993 hundred", "9007199254740993 million", "9007199254740993.5 million",
    "123456789012345678901234567890", "one quintillion two hundred quadrillion", "9007199254740993 first",
    "9007199254740992 eleventh", "one sextillion and one", "nine thousand nine hundred ninety nine decillion",
    # prefixers, suffixers, specials
    "minus cat", "minus", "five minus three", "minus minus five", "negative twenty", "plus twenty", "positive one hundred",
    "minus 500", "minus 0.5", "plus hundred", "minus point five", "dollars", "five dollars", "twenty dollars and thirty cents",
    "one pound", "pounds sterling", "two euro", "euros", "forty cent", "cents", "a dollar", "seventy six per cent", "per cent",
    "five per", "five per hour", "per hour", "percent", "five percent", "three percent per year", "per", "one per",
    "ninety nine per cent sure", "and", "and cat", "five and", "five and cat", "five and six", "hundred and six",
    "hundred and cat", "thousand and one", "two thousand and", "double", "double cat", "double o seven", "triple zero",
    "triple five", "five double twenty", "five triple hundred", "double twenty", "double 5", "double point", "five double", "double double", "triple triple six", "one double two three",
    "point", "point cat", "point point five", "point 5", "one point", "one point cat", "one point point five", "three point 14",
    "three point one four one five nine", "3 point 2", "fourteen point 4", "one point 5 point 6", "twenty point five",
    "point twenty", "one point twenty one", "one point oh", "one point 0",
    # arabic numerals and currency
    "3", "3.0", "007", "2.50", "1.5", "0.5", "0.0", "00.50", "1,000", "1,000,000", "1,000.50", "12:30", "3/4", "$5", "£5",
    "€5", "$5.50", "¢50", "¢5", "$1", "$1.50", "£0", "$0", "$0.50", "$0.05", "$0.5", "$0.99", "£0.07",
    "€0.12", "$0 5", "$0$5", "$0%12", "$0x12", "$0.123", "$0.5 million", "$5 and ¢7", "$2 and ¢7",
    "five dollars and seven cents", "£2 ¢50", "€3 and ¢05", "$10 ¢99", "$7 and ¢123",
    "$12 and ¢3", "3 pounds and 4 cents", "$ 5", "5 $", "$5 million", "£5 thousand", "€52.4 million",
    "$20.1 million", "$3.5 thousands", "-5", "+5", "-$5", "$-5", "10 dollars", "10 dollar sign", "1 dollar", "$1 million",
    "1s", "1st", "10 th", "10th", "21st", "1 s", "2 s", "3 rd", "1960s", "1960 s", "1 000", "one", "ones", "1", "one one",
    "one and one", "1 1", "1 and 1", "$1 and ¢1", "1 one 1", "b747", "RC232", "10km", "12mm", "a1b2c3", "x2y", "1x", "x1",
    "version 1.2.3", "ip 192.168.1.1", "1.2.3.4", "1,2,3", "1, 2", "1,234,567.89", "12,34", "3.14.", "tel 555-1234",
    # "and a half"
    "x and a half", "and a half", "two and a half", "two and a half million", "one and a half", "ten and a half hours",
    "hundred and a half", "three and a half and a half", "and a half of it", "Two And A Half", "and a halfway", "two and a  half",
    "two and\ta\nhalf", "twenty three and a half", "3 and a half", "forty eight and a half dollars", "a and a half",
    "five and a half and six and a half", "and a half and a half", "six and a half cats", "seven and  a half",
]

# --- EnglishTextNormalizer: the replacers, brackets, fillers, punctuation
TEXT = [
    "Let's go", "he's like", "she's been like", "He'd been there", "It's gone", "They'd gone home", "We'd done it", "He's got it",
    "It's done", "isn't it", "They're here", "What's up", "I'd go", "We'll see", "don't", "I'm here", "I've seen", "o'clock",
    "rock 'n' roll", "'tis the season", "can ' t", "he 's been", "he   'd been", "you  're", "Won't you", "can't wait", "ain't so",
    "Y'all come", "I wanna go", "gotta run", "gonna be", "I'ma go", "Imma go", "woulda coulda shoulda", "Yes, ma'am",
    "won’t", "don’t", "it’s", "Don't", "WON'T", "cannot", "cant", "won't've", "that's", "that's been", "nothing's gone",
    "Mr. Smith", "Mrs. Jones", "St. Louis", "Dr. Who", "Prof. Plum", "Capt. Hook", "Gov. Brown", "Ald. Lee", "Gen. Grant",
    "Sen. Warren", "Rep. Lewis", "Pres. Lincoln", "Rev. King", "Hon. Mention", "Asst. Manager", "Assoc. Dean", "Lt. Dan",
    "Col. Mustard", "Jr.", "Sr.", "Esq.", "Mr.Smith", "Mr Smith", "mr", "St Louis", "stone", "Mr. Park visited Assoc. Prof. Kim Jr.",
    "Mr. Smith's colour", "mŕ x", "mrⅠ x", "mr中", "the st", "dr who", "prof.", "ald", "reps", "gens",
    "Hello, world!", "a.b.c", "end.", "e.g. this", "...", "1. 2. 3.", "U.S.A.", "$.50", "5 %", "%", "50%", "5%.", "a%b", "100 %",
    "$5.", "£.", ".5", "word.5", "5.word", "10.5.", "1.", "50% off!", "100% sure", "ice-cream", "x*y", "~5", "a+b", "=", "^",
    "|", "`", "\"quoted\"", "'single'", "a_b", "a/b", "@home", "#1", "a, b; c: d", "who? what!", "(", ")", "[", "]", "<", ">",
    "5 % 5", "a $ b", "a ¢ b", "a € b", "a £ b", "a . b", "a .b", "a. b", "a.", ".", "$", "¢", "$$", "%%",
    "a$", "$a", "a$5", "5$a", "$a5", "a%", "%a", "5%a", "a%5",
    "¥100", "100¥", "₹100", "¤", "5€", "5£", "5¢",
    "[music] hello", "<noise> hi", "[unclosed", "a [b] c [d] e", "x <y] z", "x [y> z", "(laughs) ok", "(a)(b)", "()", "(nested (inner) outer)",
    "hello (world", "[a (b] c)", "text [with\nnewline] more", "(multi\nline) done", "<>", "[]", "a<b", "a>b", "<a><b>",
    "um", "uh huh", "hmm", "mm-hmm", "mhm yes", "mmm", "umbrella", "drum", "Um, well", "uh-oh", "hmmm", "mmmm", "uhh", "um um um",
    "Um...", "(um)", "yum", "um5", "5um", "_um_", "um_",
    "The quick brown fox", "  leading", "trailing  ", "a   b", "", " ", "   ", "\n", "\t", "a\tb", "a\nb", "a\r\nb", "a\r\n\r\nb",
    "I have 2,000 apples and 3 oranges", "He paid $5.50 for 3 apples", "the 1990s were fun", "in 1985", "at 3:30 pm", "12/25/2020",
    "5-4-3", "it costs five dollars and fifty cents", "she is twenty one years old", "I was born on the third of May nineteen eighty",
    "call 911 now", "dial nine one one", "the price rose 3.5 percent", "he scored double digits", "triple the amount",
    "two thousand and twenty four", "one in a million", "a million dollars", "a hundred thousand", "it's 5 o'clock",
    "ten past two", "page 3 of 10", "chapter two section four", "he ran 10km in 45 min", "RC232 and B747 and 3D",
    "COVID-19 is 19", "x = 5 + 3", "5 + 3 = 8", "3 x 4", "3*4", "1/2 cup", "one half", "two thirds", "a third",
]

# --- spelling (english.json) and Object.prototype names, which a plain object lookup would resolve
SPELLING = [
    "colour", "favourite", "mobilisation", "cancelation", "Centre", "theatre", "grey", "gaol", "judgement", "programme", "labour",
    "behaviour", "analyse", "catalogue", "dialogue", "aluminium", "the colour of the centre", "Colour, Favourite; Labour!",
    "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype", "__defineGetter__", "Constructor", "__PROTO__",
    "hasownproperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__lookupGetter__", "the constructor of __proto__",
    "constructor constructor", "5 constructor", "constructor 5", "constructor.", "(constructor)", "__proto__ __proto__ __proto__",
    "colour constructor __proto__ centre", "five constructors", "constructor's", "__proto__'s", "2 __proto__",
]

# --- Unicode, one thing at a time
UNICODE = [
    "café", "CafÉ", "café", "œuvre", "ŒUVRE", "Straße", "STRAẞE", "æsop", "ÆSOP", "øre",
    "ØRE", "đ", "Đ", "ð", "Ð", "þ", "Þ", "łódź", "ŁÓDŹ",
    "don’t", "‘quoted’", "“quoted”", "a—b", "a–b", "a…b", "a·b", "a•b", "¿qué?",
    "¡hola!", "naïve", "façade", "Ångström", "İstanbul", "ΑΣ", "ΣΑΣ", "K", "Ω",
    "Ĳ", "ĳ", "ﬁnd", "ﬃ", "½", "¼ cup", "²", "x²", "10³", "①", "①②",
    "Ⅰ Ⅱ", "ª", "º", "µ", "Å", "ẛ̣", "̈́", "ᾀ", "क़",
    "２０", "２０ １", "１,０００", "３.５", "＄５", "％", "50％",
    "ＡＢＣ", "ａｂｃ", "！", "．", "，",
    "a b", "a  b", "5 000", " leading", "trailing ", "one hundred", " 5 ",
    "٣", "٣.٥", "٣.٠", "٣ ٤", "٣ hundred", "٣.٥ million", "٣٤٥",
    "٠", "٠٠٧", "$٣", "£٣.٥", "٣%", "٣ point ٥", "three point ٥",
    "٣ th", "٣th", "x٣", "٣x", "1٣", "٣ 1", "٣ and a half", "٣ percent", "٣ dollars",
    "٣.٥ thousands", "٣.٥.٧ hundred", "۳", "۳.۵", "३", "๓", "๓.๕",
    "\u0085", "a\u0085b", "\u001c", "a\u001cb", "\u001f", "a\u001fb", "﻿", "a﻿b", "﻿5", "5﻿", "﻿$5",
    " ", "a b", "a b", "5 000", "​", "a​b", "5​0", "‍", "⁠",
    "constructor\u0085constructor", "__proto__ x", "﻿constructor", "constructor﻿", "﻿__proto__",
    "\U0001d400", "\U0001d7ce", "\U0001d7d8\U0001d7d9", "\U0001f600", "a\U0001f600b", "\U0001f600 5", "5 \U0001f600", "\U00010400",
    "\U00010428", "\U0001d41a", "\U00020000", "\U00020000\U00020001", "a\U00020000", "\U0001d7ce hundred",
    "é", "é̂", "́", "áb", "̀x", "x̀", "5́", "́́", "⃝", "a⃝b",
    "ก", "中文", "日本語 5", "مرحبا", "שלום", "नमस्ते",
    "สวัสดี", "한글", "язык", "ελληνικά",
    "À́", "À", "ÀÀ", "ẞ", "Ǆ", "ǅ", "ǆ", "Ǳ", "ǲ",
]

# --- every character str.isspace() is true for, and the look-alikes it is false for, between two words and around a digit
WHITESPACE = ["a" + chr(cp) + "b" for cp in range(0x110000) if chr(cp).isspace()]
WHITESPACE += ["5" + chr(cp) + "6" for cp in range(0x110000) if chr(cp).isspace()]
WHITESPACE += ["a" + chr(cp) + "b" for cp in (0xfeff, 0x200b, 0x200c, 0x200d, 0x2060, 0x180e, 0x061c, 0x00ad, 0x034f)]
WHITESPACE += ["x" + chr(cp) + "'s" for cp in (0x09, 0x0a, 0x0d, 0x1c, 0x1f, 0x85, 0xa0, 0x2028, 0x3000, 0xfeff)]

# --- the Nd digits of Unicode 13 and earlier: 0-9 in a run, as a number and as the head of a decimal
DIGIT_ZEROS = [0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040,
               0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0,
               0xa9f0, 0xaa50, 0xabf0, 0x104a0, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0,
               0x11730, 0x118e0, 0x11c50, 0x11d50, 0x11da0, 0x16a60, 0x16b50, 0x1e950]
DIGITS = []
for zero in DIGIT_ZEROS:
    run = "".join(chr(zero + i) for i in range(10))
    assert all(unicodedata.category(c) == "Nd" for c in run), hex(zero)
    DIGITS += [run, run[2] + "." + run[5] + " thousand", "$" + run[7] + run[0] + " " + run[4] + " percent"]


def inputs():
    return list(dict.fromkeys(NUMBERS + TEXT + SPELLING + UNICODE + WHITESPACE + DIGITS))  # first occurrence wins


def main():
    fresh, dst = sys.argv[1:3]
    pkg = types.ModuleType("upstream_normalizers")
    pkg.__path__ = [fresh]
    sys.modules[pkg.__name__] = pkg
    std = importlib.import_module("upstream_normalizers.english").EnglishTextNormalizer()
    cases = [[s, std(s)] for s in inputs()]
    lines = ",\n".join("  " + json.dumps(c, ensure_ascii=True, separators=(",", ":")) for c in cases)
    head = json.dumps({"upstream": "openai/whisper@" + SHA, "python": platform.python_version(), "unicodedata": unicodedata.unidata_version}, separators=(",", ":"))
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(head[:-1] + ',"cases":[\n' + lines + "\n]}\n")
    print(len(cases), "cases")


main()
