# Releases
(Written by AI. Not finalized yet)


Linux ARM64 is the first release target; local x64 builds are for development
and testing.

## Stage the runtime

For ARM64, set `PMJS_SOURCE_URL` to the permanent download URL for the matching
source archive, then prepare an empty staging destination:

```sh
python3 tools/dependencies.py --jobs 4
export PMJS_SDK_ROOT="$PWD/.cache/linux-arm64/sdk"
export PMJS_NODE_ROOT="$PWD/.cache/linux-arm64/node"
export PMJS_SKIA65_COMPONENT_DIR="$PWD/.cache/components/arm64"
export PMJS_EFFEKSEER_ARCHIVE="$PWD/.cache/effekseer/source.tar.gz"
export PMJS_LZ4_ARCHIVE="$PWD/.cache/lz4/source.tar.gz"
export PMJS_ASTCENC_ARCHIVE="$PWD/.cache/astcenc/source.tar.gz"
cmake --preset linux-arm64
python3 tools/release.py sources --sdk "$PMJS_SDK_ROOT" --output dist/pmjs-ffmpeg-sources.tar.gz
python3 tools/release.py stage --build build/linux-arm64 --output dist/pmjs-arm64 \
  --sources dist/pmjs-ffmpeg-sources.tar.gz --sources-url "$PMJS_SOURCE_URL"
```

For a separate x64 runtime build, use `cmake --preset runtime-x64`, build
`pmjs_native`, then stage with `tools/release.py stage`.

```text
bin/pmjs           launcher
bin/node           bundled Node, when selected
lib/               addon and native libraries
share/pmjs/        runner, modules, diagnostics and notices
build-info.json    runtime configuration and a compact payload checksum
LICENSE
THIRD_PARTY_NOTICES.md
```

The installation can be moved outside the build tree. ARM64 packages include
Node and nongraphics dependencies; SDL2, EGL, GLES and graphics drivers come
from the firmware. The ABI baseline is glibc 2.28, GLIBCXX 3.4.21,
CXXABI 1.3.11 and GCC 7.0.0. The system also supplies `libatomic.so.1`
with LIBATOMIC 1.0 for Node.

Release staging strips Release binaries and audits the ABI. Source identity
and file inventories go in `RUNTIME.release.json`
beside the runtime; keep the matching source archive there too. Documentation,
host tools and source materials are excluded from the runtime.

## Verify

On x64, relocate the package and test graphics under Xvfb:

```sh
python3 tools/release.py verify --stage dist/stage-x64 \
  --report dist/verification-x64.json --graphics --xvfb
```

On an x64 host, an ARM64 package can only be checked statically:

```sh
python3 tools/release.py verify --stage dist/pmjs-arm64 \
  --report dist/static-arm64.json --static
```

## Create an archive

```sh
python3 tools/release.py archive --stage dist/pmjs-arm64 \
  --report dist/static-arm64.json --output dist/pmjs-linux-arm64.tar.gz
python3 tools/release.py verify-archive --archive dist/pmjs-linux-arm64.tar.gz
```

The archive contains only the runtime. Publish it with the matching source archive.
Use a fresh archive filename; publication is atomic per file, not per group.
Creating an archive does not publish it.

Before distributing, test saves, repeated launching, game compatibility, audio,
controls, frame pacing and return to the menu on the intended device and firmware.

## PortMaster ZIP

See [Porting a game](porting.md) to make a bundle and package it. The firmware
must provide `libSDL2-2.0.so.0`, `libEGL.so.1`, and `libGLESv2.so.2`,
with a working SDL backend and GLES 3 context. See [system requirements](using.md#system-requirements).
Test the actual ZIP on each target firmware before distributing it.

## Redistribution

Keep license notices in the runtime and publish the referenced matching source
archive and rebuild materials alongside the distribution.
FFmpeg is built without GPL/nonfree options. Check third-party license terms
before publishing; PMJS's MIT license does not cover its dependencies.
