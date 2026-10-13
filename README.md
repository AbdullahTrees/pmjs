# PMJS

A native runtime for RPG Maker MV/MZ games

[Using PMJS](docs/using.md) · [Building](docs/building.md) · [Releases](https://github.com/bbbreaddd/pmjs)

This project started because I wanted to run In Stars and Time on my RG35XX Plus, but there didn't seem to be any known way to do it. I started trying to get Electron working on it, but Electron has a lot of limitations and quirks so I just made my own runtime that runs it natively, without a browser.

Currently only officially supports Linux ARM64.

## Current status

PMJS is experimental, but playable (hopefully). I've been focusing on ISAT, but I've also tested other games as well and it surprisingly works well. 

## Compatibility

The MV reference is stock RPG Maker MV 1.6.2, PixiJS 4.5.4 and NW.js 0.29.0, which includes Chromium 65.0.3325.146 and Node.js 9.7.1.

The MZ reference is stock RPG Maker MZ 1.10.0, PixiJS 5.3.12 and NW.js 0.48.4, which includes Chromium 85.0.4183.121 and Node.js 14.12.0.

These references guide compatibility work. Some RPG Maker MV/MZ games use different versions so behavior might not be exactly the same, but a majority of the time, it's *very* tiny differences that don't affect the experience.

## Build requirements

- CMake 3.20 or newer
- A C++20 compiler
- Node.js and Node API headers
- pkg-config
- Git and Python 3.12 or newer
- Default x64 Skia65 build: Clang/LLVM 20.1.2 (`clang-20`, `clang++-20`, `llvm-ar-20`, `llvm-strip-20`)
- ARM64 Skia65 build: `PMJS_SKIA65_ARM64_SDK` pointing to the prepared Zig 0.15.2 SDK, plus `llvm-strip-20` 20.1.2
- SDL2, EGL, and OpenGL ES 3.0 or newer
- libpng, zlib, libjpeg, FreeType, and HarfBuzz
- FFmpeg libraries: avformat, avcodec, avutil, swresample, and swscale

See [Building](docs/building.md) for detailed instructions.

## Third-party software

PMJS uses the following software:

- [Node.js](https://nodejs.org/) and [V8](https://v8.dev/) to execute game JavaScript
- [SDL2](https://www.libsdl.org/) for windows, input, and platform integration
- [EGL and OpenGL ES](https://www.khronos.org/opengles/) for native rendering
- [libpng](http://www.libpng.org/pub/png/libpng.html) and zlib for PNG images
- [libjpeg](https://ijg.org/) for JPEG images
- [FreeType](https://freetype.org/) for glyph rasterization
- [HarfBuzz](https://harfbuzz.github.io/) for text shaping
- [FFmpeg](https://ffmpeg.org/) for audio and video decoding
- [Effekseer](https://effekseer.github.io/) for RPG Maker MZ animation effects
- [Skia](https://skia.org/) and [ICU](https://icu.unicode.org/), with private FreeType/HarfBuzz builds, for the Skia65 text component

The build and test workflow uses CMake, pkg-config, ESLint, and Xvfb.

AI is used to develop this project.
