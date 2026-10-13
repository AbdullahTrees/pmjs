# Releases
(Written by AI. Not finalized yet)


Build the ARM64 installation with [build.sh](building.md) before release work.
Linux ARM64 is the first release target; local x64 builds are for development
and testing.

## Stage the runtime

The build command installs to `dist/pmjs-arm64`:

```sh
./build.sh --target arm64
```

For a separate x64 release build, use `cmake --preset release-x64`, build
`pmjs_native`, then stage with `tools/release.py stage`.

```text
bin/pmjs           launcher
bin/node           bundled Node, when selected
lib/               addon and native libraries
share/pmjs/        runner, modules, tools, docs, notices and sources
build-info.json    source, build details and file checksums
LICENSE
THIRD_PARTY_NOTICES.md
```

The installation can be moved outside the build tree. ARM64 packages include
Node and nongraphics dependencies; SDL2, EGL, GLES and graphics drivers come
from the firmware. The ABI baseline is glibc 2.28, GLIBCXX 3.4.25,
CXXABI 1.3.11 and GCC 7.0.0.

Installation checks native inputs and the addon checksum. Documentation and
JavaScript changes are recorded at installation without rebuilding native code.

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

Copy the exact ARM64 installation to the device. Use its normal display session,
stop the firmware menu through its normal lifecycle, then run:

```sh
/path/to/runtime/bin/pmjs self-test --graphics
```

Restore the menu afterward. The graphics test needs exclusive use of the display.
Save its final JSON line as `dist/device-receipt.json` on the build host.

## Create an archive

Verify the device receipt against the staged package, then archive it:

```sh
python3 tools/release.py verify --stage dist/pmjs-arm64 \
  --receipt dist/device-receipt.json --report dist/verification-arm64.json
python3 tools/release.py archive --stage dist/pmjs-arm64 \
  --report dist/verification-arm64.json --output dist/pmjs-linux-arm64.tar.gz
```

Public archives require a clean source tree, compiled provenance and a matching
graphics test. ARM64 requires a hardware renderer and Skia65. x64 may use software
rendering under Xvfb. Addon loading alone is insufficient.

The archive includes the verification report and gets a sibling `.sha256` file.
Creating it does not publish it. For a local candidate without device testing:

```sh
python3 tools/release.py archive --stage dist/pmjs-arm64 \
  --report dist/static-arm64.json --output dist/pmjs-development.tar.gz --development
```

Before distributing, test saves, repeated launching, game compatibility, audio,
controls, frame pacing and return to the menu on the intended device and firmware.

## PortMaster ZIP

See [Porting a game](porting.md) to make a bundle and package it. The firmware
must provide `libSDL2-2.0.so.0`, `libEGL.so.1`, and `libGLESv2.so.2`,
with a working SDL backend and GLES 3 context. See [system requirements](using.md#system-requirements).
Test the actual ZIP on each target firmware before distributing it.

## Redistribution

Keep license notices, dependency sources and build materials with the package.
FFmpeg is built without GPL/nonfree options. Check third-party license terms
before publishing; PMJS's MIT license does not cover its dependencies.
