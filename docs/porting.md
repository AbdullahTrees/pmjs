# Porting a game
(Written by AI. Not finalized yet)


Build PMJS, then make a bundle for your game:

```sh
dist/pmjs/bin/pmjs bundle /path/to/game --output /path/to/bundle
```

The output contains `pmjs.json`, a JavaScript bootstrap, an asset index,
your selected configuration and patches, and an empty `gamedata/`
directory. The original game files stay where they are. Run the bundle
locally with:

```sh
dist/pmjs/bin/pmjs /path/to/bundle --game /path/to/game
```

PMJS detects MV or MZ and selects known plugin patches where
supported. To choose those patches explicitly or add your own JavaScript,
pass the same options when making the bundle:

```sh
dist/pmjs/bin/pmjs bundle /path/to/game --output /path/to/bundle \
  --config /path/to/config.json --manifest /path/to/selection.json \
  --patch /path/to/first.js --patch /path/to/second.js
```

Custom patches keep their filenames in `patches/` and load in the order shown
in `pmjs.json`. Duplicate filenames get a numeric suffix. You write the patches;
bundle creation does not invent compatibility fixes. Use an empty destination and move the
completed bundle wherever you need it.

## Asset preparation

By default, PMJS prepares the game in a private temporary cache and puts
`asset-index.json` in the bundle. The index records image and map preparation
decisions, logical source paths, content hashes, and the processor versions
needed to check them. It contains no original game files, decrypted sources,
source snapshots, or decoded pixel buffers. PMJS checks each relevant input
before reuse and prepares normally when a record is stale or unsuitable.

Image preparation is lossless by default. Opt into lossy ASTC 4×4 compression
for all supported image assets in your configuration:

```json
{
  "assetPreparation": {
    "astc": { "enabled": true, "quality": "medium" },
    "losslessPrefixes": ["img/masks/", "img/parallaxes/collision"]
  }
}
```

ASTC has no minimum resolution, image-area, grayscale or frame-grid filter.
When enabled, it applies to small sprites, interfaces, grayscale images and
whole sprite sheets as well as large backgrounds. `medium` is the default
quality; `fast` and `thorough` are also supported. Higher quality increases
preparation time without changing the compressed block size. The encoder uses
one worker; cached images do not need re-encoding on ordinary launches.

Use `losslessPrefixes` for collision maps, lookup masks and other images whose
exact pixel values carry meaning. Crop/backdrop transformations that cannot be
represented directly, workspace limits and unsupported source formats retain
the ordinary lossless preparation path. Normal image-allocation bounds still
apply. Unsupported GPU formats or texture dimensions also use lossless storage.

Original files remain unchanged. Translucent images have separate straight and
premultiplied artifacts, uploaded only when requested. Full ASTC textures do not
need scrolling-window replacements. Pixel reads, mutations and mipmap generation
recover original lossless pixels. Texture promotion commits only after a
successful replacement upload and retains old textures until pending users
finish. Image GPU byte counters describe compressed API payload, which can
differ from physical residency on drivers that emulate ASTC.

Skip the index if you prefer:

```sh
dist/pmjs/bin/pmjs bundle /path/to/game --output /path/to/bundle --no-index
```

You can also include generated image pages and map atlases:

```sh
dist/pmjs/bin/pmjs bundle /path/to/game --output /path/to/bundle --include-assets
```

Those generated pages can contain game artwork. Only use this option when
you are allowed to share that content. It requires the index and never adds
the original game to the bundle. A recipient still supplies their own game;
PMJS recreates decrypted inputs and source snapshots locally as needed.

## PortMaster ZIP

Build the ARM64 installation and prepare its separate source distribution. Set
`PMJS_SOURCE_URL` to the permanent URL where that source archive will be published:

```sh
python3 tools/dependencies.py --jobs 4
./build.sh --target arm64
python3 tools/release.py sources --sdk .cache/linux-arm64/sdk --output dist/pmjs-ffmpeg-sources.tar.gz
dist/pmjs/bin/pmjs package /path/to/bundle \
  --runtime dist/pmjs-arm64 --output /path/to/game.zip \
  --sources dist/pmjs-ffmpeg-sources.tar.gz --sources-url "$PMJS_SOURCE_URL"
```

The ZIP contains a PortMaster launcher, your bundle, the ARM64 runtime and
its notices, and an empty `gamedata/`. It carries the asset index and
generated pages only if they are in the bundle. The packager checks the
runtime installation, copies its library closure, strips unstripped binaries
without changing loader symbols, and references the separate source archive.

Extract the ZIP into the firmware's ports directory and copy the game's
folder containing `www`, the `www` folder itself, or its contents into
`gamedata/`. The launcher recognizes `gamedata/Game Folder/www/index.html`,
`gamedata/www/index.html`, and `gamedata/index.html`. Keep only one game
folder when using the nested layout. Then launch it from the
firmware menu. Logs go to `log.txt`, saves to `saves/`, and caches to
`.cache/`. The launcher uses PortMaster's control and platform helpers and
cleans up the runtime when the game exits.

See [Releases](releases.md) for verification and public release checks.
