#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-only
# Rebuild the vendored decoder: needs Docker. Outputs land next to this script.
set -eu
cd "$(dirname "$0")"
[ -f ffmpeg-9.0.tar.xz ] || curl -fL --retry 10 --retry-all-errors -C - -o ffmpeg-9.0.tar.xz https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz
[ -f zlib-1.3.2.tar.gz ] || curl -fL --retry 10 --retry-all-errors -o zlib-1.3.2.tar.gz https://www.zlib.net/fossils/zlib-1.3.2.tar.gz
docker build --progress=plain -t cutframe-libav-t14 .
docker run --rm -v "$(pwd):/destination" cutframe-libav-t14
