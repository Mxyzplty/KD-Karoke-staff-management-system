# SPDX-License-Identifier: AGPL-3.0-only
# Reproducible LGPL decode-only libav.js variant for Cutframe (T14). FFmpeg is configured without --enable-gpl.
FROM emscripten/emsdk:4.0.23
RUN apt-get update && apt-get install -y --no-install-recommends git curl make m4 pkg-config xz-utils patch ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone https://github.com/Yahweasel/libav.js.git . && git checkout c05a676d16c1068cce6115594858c50a7ecad4b8
COPY config.json /tmp/cutframe-config.json
RUN cd configs && node mkconfig.js cutframe "$(cat /tmp/cutframe-config.json)"
RUN npm ci
# The FFmpeg and zlib source tarballs are fetched on the host by build.sh (their own URLs; SHA-256 in vendor/manifest.json).
COPY ffmpeg-9.0.tar.xz build/ffmpeg-9.0.tar.xz
COPY zlib-1.3.2.tar.gz build/zlib-1.3.2.tar.gz
RUN make -j"$(nproc)" dist/libav-6.10.9.0-cutframe.mjs dist/libav-6.10.9.0-cutframe.wasm.mjs
RUN mkdir /output \
 && cp dist/libav-6.10.9.0-cutframe.mjs dist/libav-6.10.9.0-cutframe.wasm.mjs dist/libav-6.10.9.0-cutframe.wasm.wasm /output/ \
 && cp build/ffmpeg-9.0/COPYING.LGPLv2.1 /output/COPYING.LGPLv2.1 \
 && grep -E 'FFMPEG_LICENSE|CONFIG_GPL ' build/ffmpeg-9.0/build-base-cutframe/config.h > /output/ffmpeg-license.txt \
 && sha256sum build/ffmpeg-9.0.tar.xz build/zlib-1.3.2.tar.gz > /output/ffmpeg-source.sha256
CMD ["sh", "-c", "cp /output/* /destination/"]
