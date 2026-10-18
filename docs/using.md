# Using PMJS
(Written by AI. Not finalized yet)

Point PMJS at an RPG Maker MV or MZ game:

```sh
/path/to/pmjs/bin/pmjs /path/to/game
```

The path can be the engine directory or a game installation with `www/`.
If you are already in that directory, run `pmjs` with no arguments. PMJS
creates a JavaScript bootstrap in your cache on first launch and refreshes it
when game scripts, patch selection, configuration, or runtime modules
change. It does not write to the original game.

Only run games you trust. Game and plugin scripts have access to Node APIs;
PMJS does not sandbox them.

## Configuration and saves

Pass `--config FILE` for runtime configuration, `--manifest FILE` to select
known plugin patches, and repeat `--patch FILE` for your own JavaScript patches
in load order. These files are included when you make a bundle. You write
custom patches yourself; PMJS does not create fixes for a game's plugins.

`--state DIR` chooses the bootstrap cache directory, `--save-root DIR`
chooses where a game saves, and `--asset-cache-root DIR` chooses where
prepared images and maps are cached. By default, bootstraps live under
`XDG_CACHE_HOME/pmjs` and saves under `XDG_DATA_HOME/pmjs`, with a separate
directory for each resolved game path. Without those environment variables,
PMJS uses `~/.cache` and `~/.local/share`. Existing save locations and game
identities still apply. Back up existing saves before trying a new game.

Prepared image pages use lossless LZ4 (`.pml4`) by default. Original game
files, ordinary images, and prepared map tiles keep their existing formats.
Set `assetPreparation.pageCodec` to `"png"` in your configuration to select
PNG image pages. Changing codecs prepares the affected images again on the
next launch; keep the cache directory so reusable maps can still be used.

Image and map preparation use kernel file locks in their cache directories. If
a cache stays busy for 15 seconds, preparation falls back to the original assets.
The lock releases automatically when its process exits; leave `.prepare.lock`
in place so all preparers continue to lock the same file.

The `preserveBitmapReloadPixels` configuration option defaults to `true`;
it keeps the previous image visible while that image reloads. Set it to
`false` for the original loading behavior.

## Run a bundle

A [game bundle](porting.md) keeps your patch setup together. Put the
original game's `www` contents inside its empty `gamedata/` directory,
then run:

```sh
pmjs /path/to/bundle
```

You can also keep the game separate:

```sh
pmjs /path/to/bundle --game /path/to/game
```

PMJS stores any refreshed bootstrap in your cache; moving a bundle does not
require editing it. An asset index may speed preparation when it matches the
recipient's game and runtime. If it does not match, ordinary preparation runs.

## System requirements

ARM64 installations include Node and nongraphics libraries. The system must
provide SDL2, EGL, and GLES 3.0 or newer, with glibc 2.28 or newer. Bundled
Node 22 targets Linux 4.18 or newer; older kernels need separate testing.
Local x64 installations use system Node and the native libraries used to
build them.

The compatibility references are MV 1.6.2/Pixi 4.5.4 and MZ 1.10.0/Pixi
5.3.12. Game and plugin support is experimental; test each game and device.

## Troubleshooting

`pmjs self-test` checks the installed files and native addon.
`pmjs self-test --graphics` also checks startup, rendering, and shutdown.
Run graphics tests in the firmware's normal display session. Stop its menu
through the normal lifecycle first, then restore it afterward. The test needs
exclusive use of the display.

For additional logging:

- `PMJS_GRAPHICS_DIAGNOSTICS=1`: graphics diagnostics.
- `PMJS_EVENT_DIAGNOSTICS=1`: enable MV event-stall timing and reports
- `PMJS_REQUIRE_HARDWARE_GL=1`: reject software rendering.
- `PMJS_COMPAT_VERBOSE=1`: log unsupported operations.
- `PMJS_STRICT_COMPAT=1`: stop at the first unsupported operation.

When reporting a problem, include `--version`, the log, firmware and kernel
versions, self-test output, and the game's engine and plugin versions. Missing
shared libraries must come from the supported system environment; keep
graphics drivers matched to the firmware.
