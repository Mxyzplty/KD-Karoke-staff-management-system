# SPDX-License-Identifier: AGPL-3.0-only
"""Explicit network preparation for T12's models. Runtime inference never downloads anything.

lock writes proposed T12 manifest rows to an external JSON file; review them and add them to
datasets/manifest.json BEFORE download or use. download takes only rows already in that manifest
and checks every byte, as apps/web/src/analysis/tools/prepare.py does for T19a. Models go to
$CUTFRAME_FIXTURES/models/t12, outside git.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.request

# key, repository, licence, weight files, use. Revisions are pinned by lock.
CATALOG = [
    ("sam2-tiny", "diffusionstudio/sam2.1-tiny-video-onnx-fp16", "Apache-2.0",
     {"vision_encoder.onnx", "mask_decoder.onnx", "memory_encoder.onnx", "memory_attention.onnx", "pointer_tpos.onnx"},
     "T12 smart-mask preview and tracking: SAM 2.1 Hiera-Tiny video graphs (512 input, fp16), exported from facebook/sam2.1-hiera-tiny (Apache-2.0)"),
    ("isnet", "onnx-community/ISNet-ONNX", "AGPL-3.0", {"model_fp16.onnx"},
     "T12 background removal: salient-object seed on a shot's first frame when no person is found"),
    ("rfdetr-seg-nano", "10sai-studio/rf-detr-seg-nano-onnx", "Apache-2.0", {"rfdetr-seg-nano.onnx"},
     "T12 background removal: person instance masks as the seed (a person wins over the most salient object, BG-P03); unchanged export of Roboflow's RF-DETR-Seg Nano (Apache-2.0, https://github.com/roboflow/rf-detr)"),
]
AGENT = {"User-Agent": "Cutframe-T12-prepare/1"}


def fetch(url):
    for attempt in range(5):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=120)
        except OSError:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def digest(file):
    h = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def lock(out, only=None):
    rows = []
    for key, repo, licence, weights, use in CATALOG:
        if only and key not in only.split(","):
            continue
        with fetch(f"https://huggingface.co/api/models/{repo}?blobs=true") as stream:
            meta = json.load(stream)
        files = []
        for item in meta["siblings"]:
            name = item["rfilename"]
            if name.startswith("onnx/"):
                if name[5:] not in weights:
                    continue
            elif name not in weights and ("/" in name or not name.endswith(".json")):
                continue
            lfs = item.get("lfs")
            url = f"https://huggingface.co/{repo}/{'resolve' if lfs else 'raw'}/{meta['sha']}/{name}"
            if lfs:
                sha, size = lfs["sha256"], lfs["size"]
            else:
                with fetch(url) as stream:
                    data = stream.read()
                sha, size = hashlib.sha256(data).hexdigest(), len(data)
            files.append({"path": f"models/t12/{repo}/{name}", "url": url, "bytes": size, "sha256": sha})
        rows.append({"id": f"T12-{key}", "name": repo, "url": f"https://huggingface.co/{repo}", "revision": meta["sha"], "licence": licence,
                     "licenceUrl": f"https://huggingface.co/{repo}/blob/{meta['sha']}/README.md", "use": use, "files": files})
        print(f"Locked {repo}: {len(files)} files, {sum(f['bytes'] for f in files)} bytes", flush=True)
    Path(out).write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")


def download(manifest, cache, only=None):
    rows = [r for r in json.loads(Path(manifest).read_text(encoding="utf-8"))["models"] if r.get("id", "").startswith("T12-")]
    if only:
        rows = [r for r in rows if r["id"] in only.split(",")]
    if not rows:
        raise RuntimeError("Add reviewed T12 rows to the manifest before downloading")
    root = Path(cache).resolve()
    for row in rows:
        for item in row["files"]:
            target = (root / item["path"]).resolve()
            if not target.is_relative_to(root):
                raise RuntimeError("Manifest path escapes cache")
            if target.exists() and target.stat().st_size == item["bytes"] and digest(target) == item["sha256"]:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_name(target.name + ".partial")
            print(f"Downloading {item['path']} ({item['bytes']} bytes)", flush=True)
            with fetch(item["url"]) as source, open(temp, "wb") as dest:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    dest.write(chunk)
            if temp.stat().st_size != item["bytes"] or digest(temp) != item["sha256"]:
                temp.unlink()
                raise RuntimeError(f"Hash/size mismatch: {item['path']}")
            temp.replace(target)
    print("All T12 files verified", flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["lock", "download"])
    p.add_argument("--out")
    p.add_argument("--manifest", default=str(Path(__file__).resolve().parents[5] / "datasets/manifest.json"))
    p.add_argument("--cache")
    p.add_argument("--only")
    a = p.parse_args()
    if a.command == "lock":
        lock(a.out, a.only)
    else:
        download(a.manifest, a.cache, a.only)
