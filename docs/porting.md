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

Build the ARM64 installation and package the bundle:

```sh
./build.sh --target arm64
dist/pmjs/bin/pmjs package /path/to/bundle \
  --runtime dist/pmjs-arm64 --output /path/to/game.zip
```

The ZIP contains a PortMaster launcher, your bundle, the ARM64 runtime and
its notices, and an empty `gamedata/`. It carries the asset index and
generated pages only if they are in the bundle. The packager checks the
runtime installation, copies its library closure, strips binaries without
changing loader symbols, and includes matching source materials where
required.

Extract the ZIP into the firmware's ports directory and copy the game's
`www` contents into its `gamedata/` directory. Then launch it from the
firmware menu. Logs go to `log.txt`, saves to `saves/`, and caches to
`.cache/`. The launcher uses PortMaster's control and platform helpers and
cleans up the runtime when the game exits.

See [Releases](releases.md) for verification and public release checks.
