# Cutframe test fixtures (corpus + synthetic media)

## 2026-10-22 | Manifest (claude; stand-in finding SR-09)

**What this is.** The exact test inputs that every side-by-side test in the plan uses. The stored Xapp references (captions, transcripts, search, background removal, export, beats, the planned golden captures G-01…G-18) are only comparable if Cutframe feeds **byte-identical inputs**, so this manifest records each file's source, licence, how it was made, and its SHA-256. None of this is Xapp material; it is openly licensed footage, our own synthetic media and our own text.

**Where the files are.** Media files do not go into git (about 125 MB). They live in the **fixture store** `$CUTFRAME_FIXTURES` (on the D2 machine: `C:\Users\owner\cutframe-fixtures`, with `corpus/` and `synthetic/`), which implementers may read. T00's fixture loader reads them from there and **checks every file against the SHA-256 below before a test runs** (a mismatch fails the run with the file name). The generator for the synthetic set is `fixtures/make_synthetic.py` in this repo. Media file names keep their original names (no "(C)" tag) because the stored Xapp references and the G-request plans name them.

**Re-creating the files.**
- *Synthetic set S1–S5:* run `py -3 fixtures/make_synthetic.py` with ffmpeg on PATH. With ffmpeg 8.1.2 and the bit-exact flags the MP4 outputs reproduce the hashes below; another ffmpeg version may change the bytes, so the store copy is the reference and the generator is the documented way it was made. S3b is cut from `tos-action-30s.mp4` at 13.0 s.
- *Corpus clips:* cut from the openly licensed sources below. The exact encoder settings of the first three Tears of Steel cuts were not recorded on 21 Oct, so re-encoding will not reproduce the bytes: **the store copies are the reference**. Their stream parameters are in the tables. For publication, these files can ship as a release asset with the attribution lines below (CC BY / CC BY-SA allow redistribution with attribution).

## Corpus (openly licensed)

| File | Source | Cut / how made | Licence and attribution | Used by |
|---|---|---|---|---|
| `tos-speech-45s.mp4` | Tears of Steel 720p, `http://ftp.nluug.nl/pub/graphics/blender/demo/movies/ToS/tears_of_steel_720p.mov` | 00:00:58 + 45 s, re-encoded H.264 / AAC | CC BY 3.0; "Tears of Steel" (c) Blender Foundation, mango.blender.org | captions, transcript, search, sync |
| `tos-action-30s.mp4` | same | 00:05:20 + 30 s | CC BY 3.0 (as above) | smart mask, background removal, search, S3b |
| `tos-credits-music-40s.mp4` | same | 00:10:30 + 40 s | CC BY 3.0 (as above) | beats / BPM |
| `tos-action-90s-x3.mp4` | `tos-action-30s.mp4` concatenated three times (ffmpeg concat demuxer, stream copy) | 90.02 s | CC BY 3.0 (derived) | background removal on a > 60 s item (BG-P06) |
| `song-eternity-arcade-lost-in-a-dream-60s.mp4` | Wikimedia Commons, `File:Eternity_Arcade_-_Lost_in_a_Dream_(vocal_retro_pop_music_made_with_AI).opus` (3,571,954 bytes, sha1 a2942598d656b52f1a9cd57e4275889aeef93482) | first 60 s, AAC 160 kb/s + a flat dark 640 × 360 video track | CC BY 4.0; "Lost in a Dream" by Eternity Arcade | lyrics transcription, Music-lyrics captions |
| `amsterdam-houseboat-exif.jpg` | Wikimedia Commons, `File:Maison_flottante_Amsterdam_2.jpg` (sha1 37df2b4176007f2cd32df2f32519323715927e58) | original file, unchanged | CC BY-SA 4.0; author "Anne Jea." (Commons user .Anja.) | library Recorded sort and date/location filters (EXIF 2017-06-23 16:19:32; GPS 52.369630 N, 4.899883 E) |
| `tts-conjunctions-107s.mp4` | synthesised locally (Windows built-in voice, System.Speech) from our own text (below), flat grey 640 × 360 video | 109.36 s | own work | caption conjunction tests (CAP-P11) |
| `tts-conjunctions2.mp4` | same method, second text (below) | 89.12 s | own work | CAP-P11 second set |

Speech ground truth for WER tests (not uploaded anywhere): LibriSpeech, CC BY 4.0, openslr.org/12 (T19 datasets manifest).

| File | Bytes | SHA-256 | Streams (ffprobe) |
|---|---|---|---|
| `amsterdam-houseboat-exif.jpg` | 2841855 | `4fed86819b222f8a0a137a2848f61da9c0e311cf9791063bc050334b58baec56` | mjpeg 2736x3648 25/1 yuvj440p |
| `song-eternity-arcade-lost-in-a-dream-60s.mp4` | 1315343 | `7cc912fc402035428c231858f876e661cfcd81676baab7c507a209f28fe4d361` | h264 640x360 25/1 yuv420p; aac 48000 Hz 2ch; 60.000 s |
| `tos-action-30s.mp4` | 6789415 | `1150283b06fdd183f496086daa37e989e08f010f056491e6c421007c5b7d805e` | h264 1280x534 24/1 yuv420p; aac 44100 Hz 2ch; 30.000 s |
| `tos-action-90s-x3.mp4` | 20366463 | `91d2563ebc795b62db87dce6f57053af74ff3bedf2cd8c48855fdd25ae53beff` | h264 1280x534 24/1 yuv420p; aac 44100 Hz 2ch; 90.023 s |
| `tos-credits-music-40s.mp4` | 13342839 | `0d94f4ea28dcacfb0cfbf08d3a9fe669a1138e6efa776c4a305cded8b38ec540` | h264 1280x534 24/1 yuv420p; aac 44100 Hz 2ch; 40.000 s |
| `tos-speech-45s.mp4` | 8057475 | `9affcad890b8bb3b485ab77406eaad7e7a75b5373dfdaf2a2decb9eebf86bd8e` | h264 1280x534 24/1 yuv420p; aac 44100 Hz 2ch; 45.000 s |
| `tts-conjunctions-107s.mp4` | 1220386 | `7df8e465e00b314e033692d48b51be0ad100c31d1af869c03215bb4ecb676f80` | h264 640x360 25/1 yuv420p; aac 22050 Hz 1ch; 109.360 s |
| `tts-conjunctions-107s.txt` | 1593 | `2924d0ae67fae8abf61b005232ef7ccdc862b6a502c9378f10a112e526d58a80` | — |
| `tts-conjunctions2.mp4` | 918807 | `102b7a0257349f83174af014fcb8f8a426688bee9582da62ca5fe2d73a983ec1` | h264 640x360 25/1 yuv420p; aac 22050 Hz 1ch; 89.120 s |
| `tts-conjunctions2.txt` | 1093 | `609ce6953dc5e86c2e7cf57d0f39fde2b703b2841af64e8bcf28712539572b7a` | — |

## Synthetic set (our own, D9)

| File | What | Used by |
|---|---|---|
| S1 `S1-framecount-1080x1920-30fps-10s.mp4` | test pattern, big burned-in frame number, time label, a red box moving 360 px/s; 300 frames, H.264, no audio, GOP 30, no B-frames | G-01, G-02, G-11, G-16 |
| S2 `S2-framecount-tone-1920x1080-30fps-10s.mp4` | landscape version + a 100 ms 1 kHz tone burst at every whole second (AAC 48 kHz stereo 192 kb/s) | G-08, G-09 |
| S3a / S3b / S3c | horizontal black → white gradient; corpus frame (tos-action-30s at 13.0 s, scaled to width 1080, padded black); white "TEXT" on a transparent background | G-07 |
| S4 `S4-black-1080x1920-3s.mp4` | 3 s solid black | G-03 |
| S5a…S5i | problem media, 3 s each: VFR (65 frames, average ≈ 22.2 fps), HDR10 PQ HEVC 10-bit, HLG HEVC 10-bit, 90° rotation flag, AC-3 audio, E-AC-3 audio, MKV (H.264 + Opus), ProRes 422 MOV, HEVC 10-bit SDR | G-10, T14 |

| File | Bytes | SHA-256 | Streams (ffprobe) |
|---|---|---|---|
| `S1-framecount-1080x1920-30fps-10s.mp4` | 13871655 | `ac36e9d68670b5307c787af178bdfdaaccf4007f54c9b42217f96435afce9dce` | h264 1080x1920 30/1 yuv420p; 10.000 s |
| `S2-framecount-tone-1920x1080-30fps-10s.mp4` | 12270730 | `4d540f0938696e3da60b8e4dabad0d16c89c61bd399636417408d1f435551f04` | h264 1920x1080 30/1 yuv420p; aac 48000 Hz 2ch; 10.000 s |
| `S3a-gradient-1080x1920.png` | 12612 | `45396a2ecba8969ed2c0dd5b0ded3139d713fe191f27798e8eedd33dee753ca8` | png 1080x1920 25/1 rgba |
| `S3b-corpus-frame-tos-action-13s-1080x1920.png` | 435829 | `fb7ef166984cef81a5427bb8acd20c7ed3eb41cb6b54c2173aded84be1eaf975` | png 1080x1920 25/1 rgb24 |
| `S3c-text-on-alpha-1080x1920.png` | 24596 | `4de79968819a17bac90b6d9d3ccdb88fb1b07058b5c86a57cc62eb83defb1789` | png 1080x1920 25/1 rgba |
| `S4-black-1080x1920-3s.mp4` | 9000 | `9acba7bfb6dd2c0ccd033ddd9cd8c8ba05f48290f91e4591c7686539f24d30d0` | h264 1080x1920 30/1 yuv420p; 3.000 s |
| `S5a-vfr.mp4` | 2636320 | `ddfd7cbcddb36d629eee8a2e47fc8201b98a9ce60d0538f79a028264d1f47427` | h264 1920x1080 975/44 yuv420p; aac 48000 Hz 1ch; 3.000 s |
| `S5b-hdr10-pq-hevc10.mp4` | 1923715 | `178413673fb6b261b3bfd2766aa41cf5750d559cd3ee6eff6f85bd7739cb5163` | hevc 1920x1080 30/1 yuv420p10le; aac 48000 Hz 1ch; 3.000 s |
| `S5c-hlg-hevc10.mp4` | 1923715 | `8903a9932c5985270cb8a7437008295735cb496d1ba14db5b1420243cd5ace8b` | hevc 1920x1080 30/1 yuv420p10le; aac 48000 Hz 1ch; 3.000 s |
| `S5d-rotation-90.mp4` | 3228623 | `603877e5c33f4ab8e153e270a9573a7e8b441509e27d22fd5e2c28fb9f475001` | h264 1920x1080 30/1 yuv420p; aac 48000 Hz 1ch; 3.000 s |
| `S5e-ac3-audio.mp4` | 3272915 | `70fe2470166c08f7fa21e43306eb6dcd5d8218af3abf6f17609f57d56577f057` | h264 1920x1080 30/1 yuv420p; ac3 48000 Hz 1ch; 3.000 s |
| `S5f-eac3-audio.mp4` | 3272917 | `c6d97b5dfb83f12f23b341a45b537e441d2767bf58ccd21c4099cded3b2a041c` | h264 1920x1080 30/1 yuv420p; eac3 48000 Hz 1ch; 3.000 s |
| `S5g-container.mkv` | 3258332 | `d283dea74972722f9d228760fda219dc5db93033d43a571c9502d4f92faa6928` | h264 1920x1080 30/1 yuv420p; opus 48000 Hz 1ch; 3.008 s |
| `S5h-prores422.mov` | 21426280 | `3af5c4cafaf3f9101d1980dd8095e7360c5a0692f6181aade405b1d5537e3c1a` | prores 1920x1080 30/1 yuv422p10le; pcm_s16le 48000 Hz 1ch; 3.000 s |
| `S5i-hevc10-sdr.mp4` | 1865375 | `a0a540fd040b1e7bcdf76cfb8954b5a709c48a8e1779225b4228c3a07be28d6d` | hevc 1920x1080 30/1 yuv420p10le; aac 48000 Hz 1ch; 3.000 s |

## Our own TTS texts (the scripts spoken in the two conjunction clips)

**tts-conjunctions-107s:**

> The team finished the report early and went home. The weather looked terrible but the match went ahead. You can take the train or you can drive the car. The room was empty so we left through the back door. He was very tired yet he kept on working all night. She stayed inside because the rain was getting heavier. They cleaned the kitchen then they washed the dishes. He opened a box which contained several old letters. I think that the plan will work well for everyone. We will start the meeting when everyone has arrived. The dog barked while the children played in the garden. She kept smiling although she felt rather nervous. He went outside though it was already dark. We have waited here since the morning started. You will not pass unless you study a little harder. Wait here until the others come back from lunch. Check the lights before you leave the building tonight. Call me after the show ends this evening. I do not know whether the shop is open today. We will finish on time if the printer works again. Nobody called nor did anyone send a message. He was taller than his brother is now. She likes tea whereas he prefers coffee in the morning. He read the book once he finished his homework. I will stay for the whole show for I love music. Everyone clapped as the singer left the stage. He is smart plus he is very kind to people. The server crashed however the backup kept running. She is also learning Spanish this year. I know where the keys are hidden. The man who lives next door is away. He smiled even though he was upset. The road was closed so that nobody could pass.

**tts-conjunctions2:**

> We checked the engine and then we waited. And the lights came on. It was late. But we stayed anyway. Or maybe we should go. So we left. Yet nobody complained. For the night was warm. Nor did we mind. Because the road was clear. You can have either tea or coffee. He likes neither tea nor coffee. Hurry up otherwise we will miss the bus. It rained all day therefore we stayed home. The test failed thus we fixed the code. Prices rose hence people bought less. The plan is cheap moreover it is fast. The tool is simple furthermore it is free. I chose tea instead of coffee today. She cooked dinner meanwhile he cleaned up. Nobody came besides the two neighbours. Call me whenever you feel ready. We will follow wherever you decide to go. Wear a coat lest you catch a cold. He worked whilst she was sleeping upstairs. It was a good plan albeit a risky one. We will go provided the weather stays dry. Everyone came except the manager himself. The cake tastes like it came from a shop. It was late, so, we left early. Take it or leave it, but, do not argue. Tea, or coffee, will be served at noon.

## Number-only fixtures (22 Oct; master plan §5 prerequisites)

Our own JSON files in this folder (numbers, our own field names, Tears of Steel dialogue and our own TTS text only; the CC BY song's lyrics are masked letter by letter):

- **OT-7** caption chunk cases: 66 cases (25 wave-2 chunk responses, 10 wave-2 template applies, 31 wave-3 pairs), 2,163 words, 496 expected chunks; our own implementation of findings part 3 §44.2 reproduces all 66. Five wrong variants of the rule fail between 2 and 66 cases each, so the fixture discriminates. Not covered: the order of server-side sorting (every input was already sorted) and two readings of the same-item hold cap (both pass).
- **OT-6** the 13.92 s wave-2 export timeline rebuilt as a project of our own schema: tos-speech-45s 0–5.977 s, a 1 s Fade (dip through black) centred on the cut at 5,977.236 ms, tos-action-30s 0–3.96 s, tos-credits-music-40s 0–3.99 s, a "Heading" text and a caption; 418 frames at 30 fps. Its two fonts are in the store (section "Fonts" below).
- **OT-3** search relevance key: 24 queries × 3 clips, 106 graded ranges in source seconds (grade 2 = clearly matches, 1 = partly), with the written rubric; agent-judged on 22 Oct from extracted frames and transcript word times; a human spot check is optional.

| File | Bytes | SHA-256 |
|---|---|---|
| `OT-7 caption chunk cases (C).json` | 255574 | `1f43c5ab832d2eefdfd0a691c9170db4f8c5ee25e76c4780436e5db4ca108217` |
| `OT-6 export timeline 13.92s (C).json` | 16058 | `04a201a4dd72337ad9b76a8089b0a386a58718bbadba6cccbeb1230579bda694` |
| `OT-3 search relevance key (C).json` | 29581 | `ee58720dc29165e06f7323d2d697d6f2f786d9d337d4d5d0c6b3c89a9cd3027c` |

## Fonts (added 22 Oct 17:0x; needed by OT-6 and the caption / text render tests)

The exact font files Xapp's current build loads for these faces (its font catalogue points to these public Google Fonts URLs). Byte-identical files matter because text layout and rasterisation are compared at the pixel level. Stored in `$CUTFRAME_FIXTURES/fonts/`; the T00 loader hash-checks them like the media. **Licences (settled 22 Oct evening):** read from each file's own name table (licence description = name ID 13, licence URL = name ID 14). Each licence is stored next to its font as `<font>.LICENSE (C).txt` (the embedded description and URL, plus the embedded copyright line); T00's licence check compares these files with the fonts. Both licences are compatible with AGPL-3.0.

| File | Source URL (Google Fonts CDN) | Bytes | SHA-256 | Licence (embedded in the font) | Licence file in the store |
|---|---|---|---|---|---|
| `OpenSans-Regular.ttf` | `https://fonts.gstatic.com/s/opensans/v27/memSYaGs126MiZpBA-UvWbX2vVnXBbObj2OVZyOOSr4dVJWUgsjZ0C4nY1M2xLER.ttf` | 129796 | `8c23cd4f8fea19c5c6297f5399b91c6ffa40a23ca85939b8140abe5d755be2e6` | SIL Open Font License 1.1 (`http://scripts.sil.org/OFL`); Version 3.000; © 2020 The Open Sans Project Authors | `OpenSans-Regular.LICENSE (C).txt` |
| `OpenSans-Bold.ttf` | `https://fonts.gstatic.com/s/opensans/v27/memSYaGs126MiZpBA-UvWbX2vVnXBbObj2OVZyOOSr4dVJWUgsg-1y4nY1M2xLER.ttf` | 129784 | `d8229f8206a0b49a2dc74820a78380eaf807c3d0f2066a53562d2b650aa21139` | SIL Open Font License 1.1 (`http://scripts.sil.org/OFL`); Version 3.000; © 2020 The Open Sans Project Authors | `OpenSans-Bold.LICENSE (C).txt` |
| `Roboto-Bold.ttf` | `https://fonts.gstatic.com/s/roboto/v29/KFOlCnqEu92Fr1MmWUlvAx05IsDqlA.ttf` | 167336 | `baf44ce81636cc927fc27768437e5da853bac699e8aaf832d042f0dfed29b4b4` | Apache License 2.0 (`http://www.apache.org/licenses/LICENSE-2.0`); Version 2.137, 2017; © 2011 Google Inc. | `Roboto-Bold.LICENSE (C).txt` |

The other caption-template fonts (Anton and the rest of findings part 3 §44.3) follow the same rule when their tests are written: the URL from the font registry of findings part 2 §33, the file in the store, the hash here.

**CJK render font (T05, added 3 Nov).** The text chain loads an open CJK font on demand — Noto Sans SC — from Google Fonts' CSS2 API (`https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@100..900&display=block`, `apps/web/src/text/fonts.ts` `chainFont`). That stylesheet fans out to many `fonts.gstatic.com` subset files, so this is not a single-file fixture. **Node unit tests never load it** (`document.fonts` is absent, so the CJK animation / timing acceptance — the only part the oracle checks for CJK, "timing and motion only" — runs on `measure.ts`'s approximation with `Intl.Segmenter`, no font). The **Playwright CJK render** test routes both URLs to stored files so it never touches the network: the CSS2 request → a stored one-`@font-face` stylesheet whose `src` points at the stored subset; that `src` → a stored Noto Sans SC subset ttf covering the CJK test strings. **Production is a Author-run step** (a network fetch + `pyftsubset`, so the bytes are not reproducible and the store copy is the reference, like the corpus clips): subset Noto Sans SC to the test glyphs, place it and its `.LICENSE (C).txt` under `$CUTFRAME_FIXTURES/fonts/`, then add the hash rows above. **Until the store has it, the Playwright CJK render test skips** with the reason (the loader's `CJK_NOTICE`); every other T05 test is unaffected. See `T05 text and text animations notes (C).md` §5 (the CJK offline-notice default) and §9.

## T00 prerequisites and datasets (added 27 Oct, T00)

Store files made or fetched by T00 for the master plan §5 prerequisites. Names are store-relative paths. The loader checks these like every row above.

- **Deterministic MKV sibling.** `synthetic/S5g-container-bitexact.mkv` is the S5g command plus the bit-exact Matroska flags. Two runs of the original command gave different bytes: the Matroska segment UID is random. The original `S5g-container.mkv` above stays the reference for stored captures. `npm run fixtures` regenerates the sibling and checks it twice.
- **OT-4, FX-1, FX-2, OT-5 synthetic** (`prerequisites/`): made by `fixtures/make-prerequisites.py`, our own media. `fixtures/verify-prerequisites.py` regenerates them twice and checks the exact pixel, alpha and beat truth.
- **OT-2, OT-1, OT-5 annotated set** (`datasets/`): openly licensed sources and our derived references. Source URL, licence and model provenance are in `datasets/manifest.json` (the D14 datasets manifest). The method is in the [T00 harness runbook](<../T00 harness runbook (C).md>).

The rows between the markers are written by `datasets/build-manifest.py` from the store bytes. Do not edit them by hand.

<!-- T00 generated rows: begin -->
| File (store-relative) | Bytes | SHA-256 |
|---|---|---|
| `synthetic/S5g-container-bitexact.mkv` | 3258242 | `50c8c6fe34f451333931bff31a9c69e9ee4d18bd18906a1542009ff83bc557a1` |
| `prerequisites/FX-1-stacked-alpha-truth.npz` | 15109 | `5ad1505e413f77c34e92f17404431dab5a2da35cd428c5cd389b93563fad694e` |
| `prerequisites/FX-1-stacked-alpha.mkv` | 56745 | `3626df50c11175f5539ceaad47e0eab6c130adb749ab8b3d30e4c049f984f665` |
| `prerequisites/FX-2-1-threejs-60s.json` | 2814 | `d2a64b6607d9f17cbfb7d587b531337f116dc1e2f0925a09ce0bf18418e6c891` |
| `prerequisites/FX-2-30min-1080p.json` | 90183 | `be3127e54f4ae993cdc9621865bd257411281bbc7d1eedd1685fc75f97be1cdd` |
| `prerequisites/FX-2-5-threejs-60s.json` | 12770 | `a7517efd9076bfbaf6bc40148a169ac0aa20f89be2752dd9262f9695f743736c` |
| `prerequisites/OT-4-FX-1-description.json` | 705 | `f913553c93e96a4235bb3f69f0dd45e66dd9a9a4404f5cf7539ed365098bbada` |
| `prerequisites/OT-4-shapes-composite.mkv` | 822317 | `3b29b6d65160ae1513a14fce44d1f8e6b5827db3e566ace97d09d32525bd18a9` |
| `prerequisites/OT-4-shapes-truth.npz` | 2769128 | `cd14a0831dc366bf9a30873466aaeb4cf7b7ef34c94839af2d8b43b6bd021f17` |
| `prerequisites/OT-4-text-composite.mkv` | 864762 | `c9f35c35c85397b48f486e5f1c64f9484e696adedc91493e81b9c1d9f98ec6af` |
| `prerequisites/OT-4-text-truth.npz` | 2889370 | `e052c16a1f391dda084547b6a4456a9404d3ae13a782fecf94d82412c0c32670` |
| `prerequisites/OT-5-click-90.json` | 3778 | `746d88b1d82672dbdb1b772dbd2856d6d2696314cf5cd1794ab2cbf59805e9a7` |
| `prerequisites/OT-5-click-90.wav` | 1920044 | `068e5ff7febc08862d9e75384ca07fa0d97e15a94845fac7664ffe85dab97b0d` |
| `prerequisites/OT-5-drum-120.json` | 4699 | `b02a2d0293fc1148b7ddc131dbec956d84832db69a34c962604bbf8cbab15754` |
| `prerequisites/OT-5-drum-120.wav` | 1920044 | `c5f6444a87aa4fad4d37e1e6ce433f749a280164f80da385ebcd5430c88fd166` |
| `prerequisites/OT-5-drum-128.json` | 5058 | `c23b0c58157d29713481cccc21d7af595a244777bb5922dd7ada8800c4554fcf` |
| `prerequisites/OT-5-drum-128.wav` | 1920044 | `c097d28c755f44ce3e00a05f0f02340462e6193143d87deff0e6a57ad2ff4320` |
| `prerequisites/OT-5-drum-129.2-noise.json` | 5380 | `ca32e211bb3d06ff7fe146d40cfa491d669bc715827ac5dc7165d3cc1f237210` |
| `prerequisites/OT-5-drum-129.2-noise.wav` | 1920044 | `6fb48ff566e4b775adc170ed1b9b9ddfb6823396f06097422fed0dd06b7de517` |
| `prerequisites/OT-5-drum-140-3-4.json` | 5691 | `1c2109e7f7a647c4650549c43a61b70bd21200aa8ca5b65bd4e0eac2d09e3fad` |
| `prerequisites/OT-5-drum-140-3-4.wav` | 1920044 | `c87c20c74eb0ef642bbb660f852d92fb63f5246b8fc61f1ff53a99b3d5ed683d` |
| `prerequisites/OT-5-drum-tempo-change.json` | 4927 | `9b430d092254afffb90fcdf3d143872a2b3f595badc03435e28431d6a2820b48` |
| `prerequisites/OT-5-drum-tempo-change.wav` | 1920044 | `e5430e29191135a4dea584532443bd157d5b2d83d68e0944793ad1a64332ccfa` |
| `datasets/speech/TOS-en.srt` | 4764 | `ce9578f6fe098a5821045a38884b229160f9e7ba27890448a92f5be330c6e6fe` |
| `datasets/speech/audio-checks.json` | 3020 | `c2f8f93f54768acf887e7e64a9588ece8f0b86efb00ef1828e3f7da5daa8b4f4` |
| `datasets/speech/coverage-scan.json` | 2771 | `a3412053eb4d3bc13b77283d311a18daa0cee7e4c1ea582fd6bdddefe7ebf8d2` |
| `datasets/speech/downloads.json` | 835 | `64d57bdf7454518cb93c079206b8acc96dc77881d424ddddff6ff1bc449aeb73` |
| `datasets/speech/tos-action-30s-aligned.json` | 13620 | `fb00c7c6999b8ddd35b3487ae598ebd9b1e7f118d79963a8e8cceaa124160e78` |
| `datasets/speech/tos-speech-45s-aligned.json` | 2261 | `2dd80e1e4a6e1de6b140ed53e29ceaba07a8914f999697425b4406cb4ed50352` |
| `datasets/speech/tos-action-30s-cue39-emission.npy` | 23212 | `48a6f8c84dcac3b4084b92051aeb4e37559e77b33a9a3706c6915c5d76a1b4f7` |
| `datasets/speech/tos-action-30s-cue40-emission.npy` | 29012 | `467a60bc92c3b042c780a9bcb93ad4e0ae224b8389661307db8336c00d2932ee` |
| `datasets/speech/tos-action-30s-cue41-emission.npy` | 23212 | `162b5937686cf692a09765937a414663280b5cf1e005cbb376c2ff60eedbc74e` |
| `datasets/speech/tos-action-30s-cue42-emission.npy` | 14512 | `7a3b0b3964bc8cd13d1b80d4b971b6125ad57b0a0f3e02136770d404b29657fc` |
| `datasets/speech/tos-action-30s-cue43-emission.npy` | 11612 | `1b54ecbaade255e96ff253a1217ad79109353b84f6ab650c4a559d377c135f34` |
| `datasets/speech/tos-action-30s-cue44-emission.npy` | 20312 | `1c7c3aeebdca86a5094a5df0fe1493d642a3ee4c8f857c4a1ab0c4624a741fe1` |
| `datasets/speech/tos-speech-45s-cue11-emission.npy` | 23212 | `b1ff10d10b697b6859247c02aefdcf32669166d6434e63d439aad313b46959c4` |
| `datasets/speakers/models.json` | 1197 | `d6e3652c39e43a5c6c89a334cf8f0be51a6cb58c26fe6d1d77f9191e8c253e43` |
| `datasets/speakers/tos-action-30s-campplus-embeddings.npy` | 168064 | `3d8b8a51f2f0ed9b884315519aef6fedb4d98bc873d285275df3f25ac2bc5c59` |
| `datasets/speakers/tos-action-30s-campplus.json` | 7823 | `9ba6e14eac9dac6f8275490de13ee7210b7cf26a48bea1a0ae83997cc30cebab` |
| `datasets/speakers/tos-action-30s-consensus.json` | 6074 | `5a82ac141a92e105b766493d62c49097e1e1c6767f323e6bc1502f190219edc0` |
| `datasets/speakers/tos-action-30s-eres2net-embeddings.npy` | 40832 | `31efb5b4f588027925ecee0c0281966f2d6d60e961ee510e7b3daf864e9c66f3` |
| `datasets/speakers/tos-action-30s-eres2net.json` | 5584 | `dfa6625287a811453631cd4737e59bf14d27d8988c96ba8a421304cdac9d7c13` |
| `datasets/speakers/tos-speech-45s-campplus-embeddings.npy` | 186496 | `1ef829b5a9ec6e92fa58d5d7fcd3c9e49f3e421be0074bdf812008ea6fb9660e` |
| `datasets/speakers/tos-speech-45s-campplus.json` | 8535 | `46087440b56b5d8a62b40279da1228edd1350412e74ad65870a9487b4b04b05e` |
| `datasets/speakers/tos-speech-45s-consensus.json` | 1345 | `f85a94511f3bd35c426ec53085ab61702433f8a8d9dfe0188c0c0f1495a877e0` |
| `datasets/speakers/tos-speech-45s-eres2net-embeddings.npy` | 52352 | `c6eeca74d81ebd26461f606c39ad95a934afc8c24ca3e338322e5387a06d2f9e` |
| `datasets/speakers/tos-speech-45s-eres2net.json` | 6844 | `a0d27c2ef2519385f468a6ba27698a7c63a4823ea7aabf14784299d6cae6f69e` |
| `datasets/groove/drummer1/eval_session/1_funk-groove1_138_beat_4-4.mid` | 4793 | `0c579a8e907ef5a9ccb7e47096f9894179a3a0ab1a2d97acb420044fc34f3562` |
| `datasets/groove/drummer1/eval_session/1_funk-groove1_138_beat_4-4.wav` | 4919604 | `38ea8fc3ce15f1e69a14dbf25d9e6005002cc05673281d13370f8bd4ef778ad3` |
| `datasets/groove/drummer3/session1/11_rock_120_beat_4-4.mid` | 1688 | `cf815f8e5c34dc0a6e5182a06d93d3360e45036f846b81037d4b82565abaeedf` |
| `datasets/groove/drummer3/session1/11_rock_120_beat_4-4.wav` | 2126308 | `760a90ac7ea8888ee7e2d31c2b517f79a7003430b0da3ca4cda36316b0521634` |
| `datasets/groove/drummer3/session2/10_rock_100_beat_4-4.mid` | 1277 | `0be1e17288f823385d54d930bb2a8118700b8c3909da2bc88c3f01e78348a6d3` |
| `datasets/groove/drummer3/session2/10_rock_100_beat_4-4.wav` | 3818950 | `2ab8c4258153c2d30f4151fe8861180819d525de750a9a094a4b9c963efd90f1` |
| `datasets/groove/groove-v1.0.0-midionly.zip` | 3260318 | `651cbc524ffb891be1a3e46d89dc82a1cecb09a57c748c7b45b844c4841dcc1e` |
| `datasets/groove/info.csv` | 206476 | `3e17eef2f18012c0160c183ad5b106964eb429876cceb1eee1b746def4e6b11b` |
| `datasets/groove/test-subset.json` | 20355 | `781ca5d66fab60ba7358cd6881df44075f7900cdbe2b5cb0dd4bfdb022ed0b85` |
| `datasets/geonames/cities15000.zip` | 3364082 | `767af45ad4d11a21475d0cf8be377d7821030caa771b35c0a294de91ada68bca` |
| `datasets/geonames/countryInfo.txt` | 31690 | `c55f638cfaafb4fe45a9aa15120a0f1f78e8a34a8e1847d7b9320cf740fbc9ab` |
<!-- T00 generated rows: end -->
