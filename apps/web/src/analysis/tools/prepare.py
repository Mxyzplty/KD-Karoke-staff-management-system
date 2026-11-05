# SPDX-License-Identifier: AGPL-3.0-only
"""Explicit network preparation only. Runtime inference never downloads models.

lock writes proposed T19a manifest rows to an external JSON file; review/add those
rows to datasets/manifest.json BEFORE download/use. download accepts only locked
rows already in that manifest and checks every byte. No private references used.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import tarfile
import urllib.request

CATALOG = [
    ("whisper", "onnx-community/whisper-small_timestamped", "MIT", {
        "encoder_model.onnx", "decoder_model_merged_q4.onnx"}),
    ("vision", "onnx-community/Florence-2-base-ft", "MIT", {
        "vision_encoder.onnx", "embed_tokens.onnx", "encoder_model_q4.onnx", "decoder_model_merged_q4.onnx"}),
    ("embedding", "Xenova/all-MiniLM-L6-v2", "Apache-2.0", {"model_quantized.onnx"}),
    ("sound", "Xenova/ast-finetuned-audioset-10-10-0.4593", "BSD-3-Clause", {"model_quantized.onnx"}),
    ("vad", "onnx-community/pyannote-segmentation-3.0", "MIT", {"model.onnx"}),
    # New-model round entries are pinned to the revision whose licence was checked.
    ("wespeaker", "onnx-community/wespeaker-voxceleb-resnet34-LM", "CC-BY-4.0", {"model.onnx"}, "6a61a1833ff2583aabeba044f5c8221f00b67ceb"),
    ("aligner", "onnx-community/wav2vec2-large-xlsr-english-ONNX", "Apache-2.0", {"model_quantized.onnx"}, "a5a0efbf15dec1a4a0d46e8b9c0d207f0fc755e0"),
    ("clip", "Xenova/clip-vit-base-patch32", "MIT", {"vision_model_quantized.onnx", "text_model_quantized.onnx"}, "6b7c523703ae26e39be4b03774966f8571c7f523"),
]
USE = {
    "wespeaker": "T19q round S2 local speaker embedder (replaced T19a-speaker): one 256-d WeSpeaker ResNet34 vector per transcript segment, clustered offline with average linkage at cosine distance .60",
    "aligner": "T19a local CTC word aligner (TR-P03 new-model round). Same family as the OT-2 timing oracle (wav2vec2 CTC, 20 ms frames) but a different checkpoint and training data: XLSR-53 fine-tuned on CommonVoice 6.0 English. Base BeebekBhz/wav2vec2-large-xlsr-english @ 6c6898b7 (Apache-2.0), a copy of jonatasgrosman/wav2vec2-large-xlsr-53-english",
    "clip": "T19q round F8 local visual search channel (T19's F2): one CLIP image embedding per description segment (its first frame) and one CLIP text embedding of 'a photo of {query}.' per query",
}
# CC-BY models need a credit line (taken from the upstream model card).
ATTRIBUTION = {
    "wespeaker": "Wang, Liang, Wang, Chen, Zhang, Xiang, Deng, Qian. Wespeaker: A research and production oriented speaker embedding learning toolkit. ICASSP 2023. Pretrained wespeaker-voxceleb-resnet34-LM (WeNet, trained on VoxCeleb), via pyannote/wespeaker-voxceleb-resnet34-LM, ONNX export by onnx-community.",
}


def fetch(url):
    req = url if isinstance(url, urllib.request.Request) else urllib.request.Request(url, headers={"User-Agent": "Cutframe-T19a-prepare/1"})
    for attempt in range(4):
        try:
            return urllib.request.urlopen(req, timeout=120)
        except Exception:
            if attempt == 3:
                raise
            print(f"Retry {attempt + 1}: {url}", flush=True)
            time.sleep(2 ** attempt)


def fetch_resumable(url, temp, size):
    """Large weights: a dropped or trickling transfer (under 1 MiB in 30 s) reconnects and resumes with
    an HTTP Range from the bytes already in the .partial file. The caller still checks size and SHA-256."""
    for attempt in range(8):
        have = temp.stat().st_size if temp.exists() else 0
        if have >= size:
            return
        headers = {"User-Agent": "Cutframe-T19a-prepare/1", **({"Range": f"bytes={have}-"} if have else {})}
        try:
            with fetch(urllib.request.Request(url, headers=headers)) as source:
                with open(temp, "ab" if have and source.status == 206 else "wb") as dest:
                    window, mark = 0, time.monotonic()
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        dest.write(chunk)
                        window += len(chunk)
                        if time.monotonic() - mark >= 30:
                            if window < 1024 * 1024:
                                raise TimeoutError("transfer below 1 MiB in 30 s")
                            window, mark = 0, time.monotonic()
        except (OSError, http.client.HTTPException) as error:
            print(f"Resume {attempt + 1} after {error}", flush=True)
    if not temp.exists() or temp.stat().st_size < size:
        raise RuntimeError(f"Incomplete download: {url}")


def digest(file):
    h = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def lock(out, only=None):
    rows = []
    for key, repo, licence, weights, *pinned in CATALOG:
        if only and key not in only.split(","):
            continue
        print(f"Locking {repo}", flush=True)
        revision = f"/revision/{pinned[0]}" if pinned else ""
        with fetch(f"https://huggingface.co/api/models/{repo}{revision}?blobs=true") as stream:
            meta = json.load(stream)
        files = []
        for item in meta["siblings"]:
            name = item["rfilename"]
            if name.startswith("onnx/"):
                if name[5:] not in weights:
                    continue
            elif "/" in name or not (name in weights or name.endswith(".json") or name in {"merges.txt", "vocab.txt", "LICENSE", "LICENSE.txt"}):
                continue
            lfs = item.get("lfs")
            route = "resolve" if lfs else "raw"
            url = f"https://huggingface.co/{repo}/{route}/{meta['sha']}/{name}"
            if lfs:
                sha, size = lfs["sha256"], lfs["size"]
            else:
                with fetch(url) as stream:
                    data = stream.read()
                sha, size = hashlib.sha256(data).hexdigest(), len(data)
            files.append({"path": f"models/t19a/{repo}/{name}", "url": url, "bytes": size, "sha256": sha})
        found = {f["path"].rsplit("/", 1)[-1] for f in files}
        if not weights <= found:
            raise RuntimeError(f"Missing weights for {repo}: {weights - found}")
        rows.append({"id": f"T19a-{key}", "name": repo, "url": f"https://huggingface.co/{repo}",
                     "revision": meta["sha"], "licence": licence,
                     "licenceUrl": WHISPER_LICENCE if key.startswith("whisper") else f"https://huggingface.co/{repo}/blob/{meta['sha']}/README.md",
                     **({"attribution": ATTRIBUTION[key]} if key in ATTRIBUTION else {}),
                     "use": USE.get(key, f"T19a local {key} engine; independent of OT-1 embedding networks and OT-2 CTC aligner"), "files": files})
        print(f"Locked {repo}: {len(files)} files, {sum(f['bytes'] for f in files)} bytes", flush=True)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")


def download(manifest, cache, dataset_cache, only=None):
    """Models go to the fixture store's model subfolder; datasets go to a separate cache
    (the fixture store is read-only apart from models/t19a)."""
    document = json.loads(Path(manifest).read_text(encoding="utf-8"))
    rows = [(r, cache) for r in document["models"] if r.get("id", "").startswith("T19a-")]
    rows += [(r, dataset_cache) for r in document["datasets"] if r.get("id", "").startswith("T19a-")]
    if only:
        selected = set(only.split(","))
        unknown = selected - {r["id"] for r, _ in rows}
        if unknown:
            raise RuntimeError(f"Unknown T19a rows: {sorted(unknown)}")
        rows = [(r, base) for r, base in rows if r["id"] in selected]
    if not rows:
        raise RuntimeError("Add reviewed T19a rows to the manifest before downloading")
    for row, base in rows:
        root = Path(base).resolve()
        archive = None
        for item in row["files"]:
            target = (root / item["path"]).resolve()
            if not target.is_relative_to(root):
                raise RuntimeError("Manifest path escapes cache")
            if target.exists() and target.stat().st_size == item["bytes"] and digest(target) == item["sha256"]:
                if item.get("url"):
                    archive = target
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_name(target.name + ".partial")
            if item.get("url"):
                print(f"Downloading {item['path']} ({item['bytes']} bytes)", flush=True)
                fetch_resumable(item["url"], temp, item["bytes"])
            elif item.get("derived"):
                # Rebuilt from the row's verified source files; the hash check below makes it reproducible.
                beat_export(root, item["derived"]["from"], temp)
            else:
                # A file without its own URL is a member of the row's verified archive.
                if row["id"] == "T19a-Groove-validation":
                    raise RuntimeError(f"Missing {item['path']}: run prepare.py groove-lock (HTTP Range members)")
                if archive is None or not tarfile.is_tarfile(archive):
                    raise RuntimeError(f"No verified archive for {item['path']}")
                member = item["path"].split("/", 3)[3]
                with tarfile.open(archive, "r:gz") as tar:
                    temp.write_bytes(tar.extractfile(member).read())
            if temp.stat().st_size != item["bytes"] or digest(temp) != item["sha256"]:
                temp.unlink()
                raise RuntimeError(f"Hash/size mismatch: {item['path']}")
            temp.replace(target)
            if item.get("url"):
                archive = target
    print("All T19a files verified", flush=True)


def libri_lock(cache, out):
    """Prepare ten distinct test-clean speakers; no inference or truth scoring here."""
    root = Path(cache).resolve()
    archive = root / "datasets/t19a/librispeech/test-clean.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    url = "https://www.openslr.org/resources/12/test-clean.tar.gz"
    if not archive.exists():
        temp = archive.with_suffix(".partial")
        print("Downloading LibriSpeech test-clean archive", flush=True)
        with fetch(url) as source, open(temp, "wb") as target:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                target.write(chunk)
        temp.replace(archive)
    with archive.open("rb") as stream:
        if hashlib.file_digest(stream, "md5").hexdigest() != "32fa31d27d2e1cad72775fee3f4849a9":
            raise RuntimeError("LibriSpeech publisher MD5 mismatch")
    files = [{"path": str(archive.relative_to(root)).replace("\\", "/"), "url": url,
              "bytes": archive.stat().st_size, "sha256": digest(archive)}]
    with tarfile.open(archive, "r:gz") as tar:
        members = sorted((m for m in tar.getmembers() if m.name.endswith(".flac")), key=lambda m: m.name)
        speakers, selected = set(), []
        for member in members:
            speaker = member.name.split("/")[2]
            if speaker in speakers:
                continue
            speakers.add(speaker)
            selected.append(member)
            if len(selected) == 10:
                break
        for audio in selected:
            parent = audio.name.rsplit("/", 1)[0]
            chapter = "-".join(audio.name.rsplit("/", 1)[-1].split("-")[:2])
            for member in [audio, tar.getmember(f"{parent}/{chapter}.trans.txt")]:
                target = root / "datasets/t19a/librispeech" / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                data = tar.extractfile(member).read()
                target.write_bytes(data)
                files.append({"path": str(target.relative_to(root)).replace("\\", "/"), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    row = {"id": "T19a-LibriSpeech", "name": "LibriSpeech test-clean: first utterance of each of the first ten lexically sorted speakers", "url": url,
           "licence": "CC-BY-4.0", "licenceUrl": "https://www.openslr.org/12/",
           "attribution": "Panayotov, Chen, Povey, Khudanpur. LibriSpeech. ICASSP 2015. OpenSLR SLR12.",
           "use": "T19a independent read-speech WER, ten speakers; deterministic subset, not a full test-clean score", "files": files}
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(row, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {len(selected)} utterances; register {out} before scoring", flush=True)


# Pinned revision of the Whisper licence (the ONNX export carries no licence file of its own).
WHISPER_LICENCE = "https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE"
GROOVE = "https://storage.googleapis.com/magentadata/datasets/groove/"


class RemoteZip:
    """Seekable HTTP Range reader, so zipfile reads only the central directory and chosen members."""
    def __init__(self, url):
        with fetch(urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Cutframe-T19a-prepare/1"})) as response:
            self.url, self.size, self.position = url, int(response.headers["Content-Length"]), 0
    def seekable(self): return True
    def tell(self): return self.position
    def seek(self, offset, whence=0):
        self.position = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
        return self.position
    def read(self, size=-1):
        size = self.size - self.position if size < 0 else min(size, self.size - self.position)
        if size <= 0:
            return b""
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.position}-{self.position + size - 1}", "User-Agent": "Cutframe-T19a-prepare/1"})
        with fetch(request) as response:
            data = response.read()
            if response.status != 206 or len(data) != size:
                raise RuntimeError("Server did not honour a bounded Range request")
        self.position += size
        return data


def groove_lock(cache, midi_zip, out):
    """Beat-phase validation set, disjoint from the scored BEAT-P02 subset. Selection fixed a priori:
    every Groove `validation`-split performance with audio, beat_type `beat`, 4-4, 15-60 s, by id."""
    import csv, io, zipfile
    root = Path(cache).resolve() / "datasets/t19a/groove-validation"
    local = zipfile.ZipFile(midi_zip)
    rows = list(csv.DictReader(io.StringIO(local.read(next(n for n in local.namelist() if n.endswith("/info.csv"))).decode("utf-8"))))
    selected = sorted((r for r in rows if r["split"] == "validation" and r["audio_filename"] and r["beat_type"] == "beat"
                       and r["time_signature"] == "4-4" and 15 <= float(r["duration"]) < 60), key=lambda r: r["id"])
    full = zipfile.ZipFile(RemoteZip(GROOVE + "groove-v1.0.0.zip"))
    files, performances = [], []
    for row in selected:
        for key, archive in (("midi_filename", local), ("audio_filename", full)):
            target = root / row[key]
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(next(n for n in archive.namelist() if n.endswith("/" + row[key]))))
                print(f"Fetched {row[key]}", flush=True)
            files.append({"path": target.relative_to(Path(cache).resolve()).as_posix(), "bytes": target.stat().st_size, "sha256": digest(target)})
        # Truth is the released metronome grid from time zero (as in datasets/prepare-groove.py),
        # read from the MIDI set_tempo meta event; Groove performances have one tempo.
        midi = (root / row["midi_filename"]).read_bytes()
        tempos = {int.from_bytes(midi[i + 3:i + 6], "big") for i in range(len(midi) - 5) if midi[i:i + 3] == b"\xff\x51\x03"}
        if len(tempos) != 1:
            raise RuntimeError(f"Expected one tempo in {row['midi_filename']}: {tempos}")
        step, duration = tempos.pop() / 1e6, float(row["duration"])
        beats = [{"timeMs": n * step * 1000, "downbeat": n % 4 == 0} for n in range(int(duration / step) + 1) if n * step < duration]
        performances.append({"id": row["id"], "bpm": row["bpm"], "style": row["style"], "audio_filename": row["audio_filename"], "beats": beats})
    truth = root / "validation-set.json"
    truth.write_text(json.dumps({"selection": groove_lock.__doc__.split("Selection fixed a priori:")[1].strip(), "performances": performances}, indent=2) + "\n", encoding="utf-8")
    files.append({"path": truth.relative_to(Path(cache).resolve()).as_posix(), "bytes": truth.stat().st_size, "sha256": digest(truth)})
    row = {"id": "T19a-Groove-validation", "name": "Google Groove MIDI Dataset v1.0.0, validation split: beat, 4-4, 15-60 s (beat-phase validation, not scored)",
           "url": GROOVE + "groove-v1.0.0.zip", "licence": "CC-BY-4.0", "licenceUrl": "https://creativecommons.org/licenses/by/4.0/",
           "attribution": "Gillick, Roberts, Engel, Eck, Bamman. Learning to Groove with Inverse Sequence Transformations. ICML 2019.",
           "use": "T19a beat-phase validation outside the scored BEAT-P02 test subset; fetched by prepare.py groove-lock (HTTP Range members)", "files": files}
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(row, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {len(performances)} validation performances; register {out} before use", flush=True)


BEAT_THIS = "models/t19a/CPJKU/beat_this"
# T19q B4: BeatThis's 8-fold cross-validation checkpoints (fold0 ships; folds 1-7 only score the Groove validation set).
BEAT_FOLDS = "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/"
BEAT_SOURCE = ("beat_this-b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c.tar.gz", "https://codeload.github.com/CPJKU/beat_this/tar.gz/b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c")
# Build-time only: the export environment is not shipped and is created outside git.
EXPORT_PINS = [["--index-url", "https://download.pytorch.org/whl/cpu", "torch==2.6.0+cpu", "torchaudio==2.6.0+cpu"],
               ["numpy==2.2.6", "einops==0.8.1", "rotary-embedding-torch==0.8.6", "onnx==1.17.0", "onnxruntime==1.20.1", "soxr==0.5.0.post1"]]
EXPORT_VENV = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache")) / "Cutframe/beat-this-export-venv"


def export_python():
    python = EXPORT_VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(EXPORT_VENV)], check=True)
    for pins in EXPORT_PINS:  # a no-op once the pinned versions are installed
        subprocess.run([str(python), "-m", "pip", "install", "-q", "--disable-pip-version-check", *pins], check=True)
    return python


def beat_export(root, sources, out):
    """BeatThis checkpoint -> ONNX (beat_export.py) from hash-checked files, `sources` = [checkpoint, source tarball].
    beat_export.py itself fails at a 1e-3 logit difference from PyTorch; the T19q B4 registration requires 1e-4."""
    import tempfile
    checkpoint, tarball = (root / source for source in sources)
    with tempfile.TemporaryDirectory() as work, tarfile.open(tarball) as tar:
        tar.extractall(work, filter="data")
        tree = next(Path(work).iterdir())
        result = subprocess.run([str(export_python()), "-I", str(Path(__file__).with_name("beat_export.py")), str(tree), str(checkpoint), str(out)], check=True, capture_output=True, text=True)
    print(result.stdout, end="", flush=True)
    worst = float(re.search(r"logit difference (\S+)", result.stdout).group(1))
    if worst > 1e-4:
        raise RuntimeError(f"BeatThis export of {sources[0]} differs from PyTorch by {worst:.2e} (over 1e-4)")


def beat_lock(cache, out, folds):
    """Fetch the BeatThis sources, export each fold's ONNX twice (the two exports must be byte-identical) and
    write the proposed manifest row; register it before `download` or any use. Fold 0 alone is the shipped
    row; any other folds form the validation-only row."""
    root = Path(cache).resolve()
    files = []
    for name, url in [BEAT_SOURCE] + [(f"fold{k}.ckpt", f"{BEAT_FOLDS}fold{k}.ckpt") for k in folds]:
        target = root / BEAT_THIS / name
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            print(f"Downloading {url}", flush=True)
            # A plain read once stopped short without an error (a truncated checkpoint): take the size from
            # the server and resume until it is reached.
            with fetch(urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Cutframe-T19a-prepare/1"})) as head:
                size = int(head.headers.get("Content-Length") or 0)
            if not size:
                raise RuntimeError(f"No Content-Length for {url}; cannot check the download is complete")
            fetch_resumable(url, target.with_name(name + ".partial"), size)
            target.with_name(name + ".partial").replace(target)
        files.append({"path": f"{BEAT_THIS}/{name}", "url": url, "bytes": target.stat().st_size, "sha256": digest(target)})
    tool = Path(__file__).with_name("beat_export.py")
    for k in folds:
        sources = [f"{BEAT_THIS}/fold{k}.ckpt", f"{BEAT_THIS}/{BEAT_SOURCE[0]}"]
        target = root / BEAT_THIS / f"beat_this_fold{k}.onnx"
        second = target.with_name(target.name + ".second")
        beat_export(root, sources, target)
        beat_export(root, sources, second)
        if digest(target) != digest(second):
            raise RuntimeError(f"BeatThis fold{k} ONNX export is not byte-reproducible")
        second.unlink()
        files.append({"path": f"{BEAT_THIS}/{target.name}", "bytes": target.stat().st_size, "sha256": digest(target),
                      "derived": {"tool": "apps/web/src/analysis/tools/beat_export.py", "toolSha256": digest(tool), "from": sources,
                                  "environment": " ".join(p for pins in EXPORT_PINS for p in pins if not p.startswith("-") and "pytorch.org" not in p)}})
    ships = folds == [0]
    row = {"id": "T19a-beat-this-fold0" if ships else "T19a-beat-this-cv",
           "name": "CPJKU/beat_this fold0 (ONNX export of 8-fold cross-validation checkpoint 0)" if ships else
                   f"CPJKU/beat_this folds {','.join(map(str, folds))} (ONNX exports of the 8-fold cross-validation checkpoints; Groove validation only)",
           "url": "https://github.com/CPJKU/beat_this", "revision": "b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c", "licence": "MIT",
           "licenceUrl": "https://github.com/CPJKU/beat_this/blob/b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c/README.md",
           "attribution": "Foscarin, Schlüter, Widmer. Beat this! Accurate beat tracking without DBN postprocessing. ISMIR 2024.",
           "use": "T19q round B4 learned beat tracker for dense music (BEAT-P02). Fold 0 of BeatThis's own 8-fold split never trained on the scored take drummer1/eval_session/1; it did train on the other two scored Groove takes and on the Groove validation items outside fold 0 (see notes)" if ships else
                  "T19q round B4, scorer only: each Groove validation performance is scored with the fold checkpoint that held it out (dataset row T19q-beat-this-split). Never loaded by the product",
           "files": files}
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(row, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Locked BeatThis folds {folds}: reproducible exports; register {out} before use", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("lock")
    p.add_argument("--out", required=True)
    p.add_argument("--only", help="comma-separated catalog keys; useful when adding a new model")
    p = sub.add_parser("download")
    p.add_argument("--manifest", default="datasets/manifest.json")
    p.add_argument("--cache", default=os.environ.get("CUTFRAME_FIXTURES"), required=not os.environ.get("CUTFRAME_FIXTURES"))
    p.add_argument("--dataset-cache", default=str(Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache")) / "Cutframe/analysis-cache"))
    p.add_argument("--only", help="comma-separated manifest ids; prepare only runtime rows, excluding rejected candidates")
    p = sub.add_parser("libri-lock")
    p.add_argument("--cache", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("groove-lock")
    p.add_argument("--cache", required=True)
    p.add_argument("--midi-zip", default=str(Path(os.environ.get("CUTFRAME_FIXTURES", ".")) / "datasets/groove/groove-v1.0.0-midionly.zip"))
    p.add_argument("--out", required=True)
    p = sub.add_parser("beat-lock")
    p.add_argument("--cache", default=os.environ.get("CUTFRAME_FIXTURES"), required=not os.environ.get("CUTFRAME_FIXTURES"))
    p.add_argument("--folds", default="0", help="comma-separated BeatThis folds; 0 alone is the shipped row")
    p.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.command == "lock":
        lock(args.out, args.only)
    elif args.command == "download":
        download(args.manifest, args.cache, args.dataset_cache, args.only)
    elif args.command == "groove-lock":
        groove_lock(args.cache, args.midi_zip, args.out)
    elif args.command == "beat-lock":
        beat_lock(args.cache, args.out, [int(k) for k in args.folds.split(",")])
    else:
        libri_lock(args.cache, args.out)
