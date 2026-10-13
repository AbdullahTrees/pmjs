#!/usr/bin/env python3
"""Create a minimal PortMaster game ZIP from an installed PMJS runtime."""
import argparse
import json
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

from release import checked_manifest, digest, elf, inventory, static_audit


PORTMASTER_LAUNCHER = '''#!/bin/bash
entry_dir=$(cd -- "$(dirname -- "$0")" && pwd) || exit 1
runtime_pid=""
runtime_mounted=0
finish() {
  local status=$? child watchdog_pid
  trap - EXIT HUP INT TERM
  if [ -n "$runtime_pid" ]; then
    # A completed child PID may have been reused; signal only a current job.
    for child in $(jobs -p); do
      if [ "$child" = "$runtime_pid" ]; then
        kill -TERM "$child" 2>/dev/null || true
        (
          trap - EXIT HUP INT TERM
          delay_pid=""
          trap '[ -z "$delay_pid" ] || { kill "$delay_pid" 2>/dev/null; wait "$delay_pid" 2>/dev/null; }; exit 0' HUP INT TERM
          sleep 2 &
          delay_pid=$!
          wait "$delay_pid"
          kill -KILL "$child" 2>/dev/null || true
        ) &
        watchdog_pid=$!
        wait "$child" 2>/dev/null || true
        kill -TERM "$watchdog_pid" 2>/dev/null || true
        wait "$watchdog_pid" 2>/dev/null || true
        break
      fi
    done
    wait "$runtime_pid" 2>/dev/null || true
  fi
  if [ "$runtime_mounted" -eq 1 ]; then
    if ! $ESUDO umount "$port/runtime"; then
      echo 'PMJS runtime unmount failed' >&2
      [ "$status" -ne 0 ] || status=1
    fi
  fi
  if type pm_finish >/dev/null 2>&1 && ! pm_finish; then
    echo 'PortMaster cleanup failed' >&2
    [ "$status" -ne 0 ] || status=1
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

controlfolder=${PORTMASTER_CONTROL_DIR:-${controlfolder:-}}
for candidate in "$controlfolder" /PortMaster /opt/system/Tools/PortMaster /opt/tools/PortMaster \\
  "${XDG_DATA_HOME:-$HOME/.local/share}/PortMaster" /mnt/mmc/MUOS/PortMaster \\
  /mnt/SDCARD/Persistent/portmaster/PortMaster /roms/ports/PortMaster /roms2/ports/PortMaster; do
  if [ -f "$candidate/control.txt" ]; then controlfolder=$candidate; break; fi
done
[ -f "$controlfolder/control.txt" ] || { echo 'PortMaster control.txt not found' >&2; exit 1; }
source "$controlfolder/control.txt"
setup_status=$?
if [ "$setup_status" -eq 0 ] && [ -f "$controlfolder/mod_${CFW_NAME:-}.txt" ]; then
  source "$controlfolder/mod_${CFW_NAME}.txt"
  setup_status=$?
fi
# PortMaster replaces EXIT traps while loading its helpers.
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
[ "$setup_status" -eq 0 ] || exit "$setup_status"
get_controls || exit 1

port="$entry_dir/@ID@"
[ -z "${directory:-}" ] || port="/${directory#/}/ports/@ID@"
cd "$port" || exit 1
exec > "$port/log.txt" 2>&1 || exit 1
[ -f gamedata/index.html ] || { echo 'Missing gamedata/index.html'; exit 1; }
mkdir -p saves || exit 1
[ -w saves ] || { echo 'Save directory is not writable'; exit 1; }
if [ -f "$port/runtime.squashfs" ]; then
  mkdir -p "$port/runtime" || exit 1
  if mountpoint -q "$port/runtime"; then
    echo 'PMJS runtime mount is already in use' >&2
    exit 1
  fi
  $ESUDO mount -t squashfs -o loop,ro "$port/runtime.squashfs" "$port/runtime" || {
    echo 'Could not mount PMJS runtime SquashFS' >&2
    exit 1
  }
  runtime_mounted=1
fi
[ -x "$port/runtime/bin/pmjs" ] && [ -x "$port/runtime/bin/node" ] || {
  echo 'PMJS runtime is incomplete' >&2
  exit 1
}
export SDL_GAMECONTROLLERCONFIG="${SDL_GAMECONTROLLERCONFIG:-${sdl_controllerconfig:-}}"
if [ "${PMJS_EXIT_HOTKEY+x}" != x ]; then
  case "${HOTKEY:-}" in
    l3) export PMJS_EXIT_HOTKEY=leftstick ;;
    r3) export PMJS_EXIT_HOTKEY=rightstick ;;
    select|back) export PMJS_EXIT_HOTKEY=back ;;
    guide) export PMJS_EXIT_HOTKEY=guide ;;
  esac
fi
if type pm_platform_helper >/dev/null 2>&1; then
  pm_platform_helper "$port/runtime/bin/node" || exit 1
fi
(
  export LD_LIBRARY_PATH="$port/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export XDG_CACHE_HOME="$port/.cache"
  exec "$port/runtime/bin/pmjs" "$port" --save-root "$port/saves" --asset-cache-root "$port/.cache"
) &
runtime_pid=$!
wait "$runtime_pid"
status=$?
runtime_pid=""
exit "$status"
'''


def write_zip(directory, output, epoch):
    timestamp = time.gmtime(max(315532800, epoch))[:6]
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for file in sorted(directory.rglob('*')):
            name = file.relative_to(directory).as_posix()
            if file.is_dir() and any(file.iterdir()):
                continue
            entry = zipfile.ZipInfo(name + ('/' if file.is_dir() else ''), timestamp)
            entry.create_system = 3
            entry.external_attr = ((0o40755 if file.is_dir() else file.stat().st_mode) << 16)
            bundle.writestr(entry, b'' if file.is_dir() else file.read_bytes(),
                            compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def checked_bundle(bundle):
    descriptor = json.loads((bundle / 'pmjs.json').read_text())
    if descriptor.get('schema') != 1 or descriptor.get('kind') != 'pmjs-game-bundle':
        raise ValueError('Unsupported PMJS bundle')
    def relative(name):
        if not isinstance(name, str) or not name or '\\' in name or name.startswith('/') or (
                any(part in ('', '.', '..') for part in name.split('/'))):
            raise ValueError('Invalid path in PMJS bundle')
        return name
    if descriptor.get('game') != 'gamedata':
        raise ValueError('PortMaster bundles must use an empty gamedata directory')
    if not (bundle / 'gamedata').is_dir() or any((bundle / 'gamedata').iterdir()):
        raise ValueError('Bundle gamedata must be empty')
    patches = descriptor.get('patches', descriptor.get('adapters'))
    if not isinstance(patches, list):
        raise ValueError('Bundle patches must be an array')
    expected = {'pmjs.json'}
    for name in (descriptor.get('bootstrap'), descriptor.get('config'), descriptor.get('manifest'),
                 *patches, descriptor.get('assetIndex')):
        if name is not None:
            expected.add(relative(name))
    bootstrap = bundle / relative(descriptor.get('bootstrap'))
    if digest(bootstrap) != descriptor.get('bootstrapSha256'):
        raise ValueError('Bundle bootstrap checksum differs from pmjs.json')
    if descriptor.get('config'):
        config = json.loads((bundle / descriptor['config']).read_text())
        preparation = config.get('assetPreparation') if isinstance(config, dict) else None
        recipe = preparation.get('recipes') if isinstance(preparation, dict) else None
        if isinstance(recipe, str):
            expected.add(relative(recipe))
    if descriptor.get('assetIndex'):
        index_file = bundle / descriptor['assetIndex']
        if digest(index_file) != descriptor.get('assetIndexSha256'):
            raise ValueError('Bundle asset index checksum differs from pmjs.json')
        index = json.loads(index_file.read_text())
        if index.get('schema') != 1 or index.get('kind') != 'pmjs-asset-index':
            raise ValueError('Unsupported bundle asset index')
        images = index.get('images')
        map_index = index.get('maps')
        if map_index is not None and not isinstance(map_index, dict):
            raise ValueError('Invalid bundle map index')
        maps = (map_index or {}).get('entries', [])
        if not isinstance(images, list) or not isinstance(maps, list) or not all(
                isinstance(entry, dict) and isinstance(entry.get('outputs'), list)
                for entry in images + maps):
            raise ValueError('Invalid bundle asset index entries')
        outputs = [page for entry in images + maps for page in entry['outputs']]
        if descriptor.get('assets'):
            if descriptor['assets'] != 'assets':
                raise ValueError('Unsupported bundle asset directory')
            for page in outputs:
                if not isinstance(page, dict):
                    raise ValueError('Invalid generated asset reference')
                name = relative(page.get('path'))
                checksum = page.get('hash')
                if not name.startswith('assets/') or not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum):
                    raise ValueError('Invalid generated asset reference')
                expected.add(name)
                if digest(bundle / name) != page['hash']:
                    raise ValueError('Generated asset checksum differs from asset index')
    elif descriptor.get('assets'):
        raise ValueError('Generated assets require an asset index')
    actual = set()
    for file in bundle.rglob('*'):
        if file.is_symlink():
            raise ValueError('Bundle cannot contain symbolic links')
        if file.is_file():
            actual.add(file.relative_to(bundle).as_posix())
    if actual != expected:
        raise ValueError('Bundle contains missing or undeclared files: ' +
                         ', '.join(sorted(actual.symmetric_difference(expected))[:5]))
    return descriptor


def portmaster(stage, game, output, name=None, config=None, adapters=(), strip=None,
               bundle=None, host_runtime=None, no_index=False, include_assets=False, manifest=None,
               flat_runtime=False, extra_notices=()):
    info = checked_manifest(stage)
    if not (stage / 'bin/node').is_file():
        raise ValueError('PortMaster packaging requires a runtime with bundled target Node')
    if output.is_relative_to(stage) or (game and output.is_relative_to(game)) or (bundle and output.is_relative_to(bundle)):
        raise ValueError('Package output must be outside the runtime and game directories')
    if (game is None) == (bundle is None):
        raise ValueError('Provide exactly one of --game or --bundle')
    if include_assets and no_index:
        raise ValueError('--include-assets requires an asset index')
    if bundle and (config or adapters or manifest or no_index or include_assets):
        raise ValueError('Bundle options are set when creating the bundle, not when packaging it')
    if bundle:
        descriptor = checked_bundle(bundle)
        if name is None:
            name = descriptor.get('title')
    elif name is None:
        name = json.loads((game / 'data/System.json').read_text())['gameTitle']
    if not isinstance(name, str) or not name.strip() or re.search(r'[/\\\x00-\x1f]', name) or name.strip() in ('.', '..'):
        raise ValueError('Use a nonempty game name without path separators or control characters')
    name = name.strip()
    identifier = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    if not identifier:
        raise ValueError('Game name must contain an ASCII letter or number')
    strip = strip or next((tool for tool in ('llvm-strip-20', 'llvm-strip', 'aarch64-linux-gnu-strip')
                           if shutil.which(tool)), None)
    if not strip:
        raise ValueError('Install llvm-strip or specify --strip; package binaries must be stripped')
    if not flat_runtime and not shutil.which('mksquashfs'):
        raise ValueError('Install mksquashfs (squashfs-tools), or use --flat-runtime')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pmjs-portmaster-', dir=output.parent) as temporary:
        workspace = Path(temporary)
        payload = workspace / 'payload'
        port = payload / identifier
        runtime = port / 'runtime'
        if bundle is None:
            bundle = workspace / 'generated-bundle'
            host = host_runtime or (Path(__file__).resolve().parent.parent / 'dist/pmjs')
            if (host / 'bin/pmjs').is_file():
                command = [host / 'bin/pmjs', 'bundle', game, '--output', bundle]
                if config:
                    command.extend(['--config', config])
                if manifest:
                    command.extend(['--manifest', manifest])
                for adapter in adapters:
                    command.extend(['--adapter', adapter])
                if no_index:
                    command.append('--no-index')
                if include_assets:
                    command.append('--include-assets')
            elif no_index and manifest is None:
                command = ['node', Path(__file__).resolve().parent / 'game-bundle.mjs',
                           game, bundle, str(config) if config else '', '', *adapters]
            else:
                raise ValueError('Build a local host PMJS installation or pass --host-runtime to generate the asset index')
            subprocess.run([str(value) for value in command], check=True)
        checked_bundle(bundle)
        shutil.copytree(bundle, port)
        runtime.mkdir()
        subprocess.run(['node', '--check', port / 'bootstrap.js'], check=True)

        # Follow the installed dependency closure; firmware providers stay external.
        pending = [stage / 'bin/node', stage / 'lib/pmjs_native.node']
        copied = set()
        while pending:
            file = pending.pop()
            if file in copied:
                continue
            copied.add(file)
            target = runtime / file.relative_to(stage)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
            symbols = subprocess.check_output(['readelf', '--dyn-syms', '--wide', file])
            dynamic = subprocess.check_output(['readelf', '-d', '--wide', file])
            subprocess.run([strip, '--strip-unneeded', target], check=True)
            if (symbols != subprocess.check_output(['readelf', '--dyn-syms', '--wide', target]) or
                    dynamic != subprocess.check_output(['readelf', '-d', '--wide', target])):
                raise ValueError('Stripping changed dynamic symbols or loader information: ' + file.name)
            sections = subprocess.check_output(['readelf', '-S', '--wide', target], text=True)
            if re.search(r'\.(?:debug\w*|zdebug\w*|symtab)\b', sections):
                raise ValueError('Strip tool left debug information: ' + file.name)
            pending.extend(stage / 'lib' / dependency for dependency in elf(file)['needed']
                           if (stage / 'lib' / dependency).is_file())
        static_audit(runtime, info)
        shutil.copy2(stage / 'bin/pmjs', runtime / 'bin/pmjs')
        shutil.copy2(stage / 'build-info.json', runtime / 'build-info.json')
        shutil.copytree(stage / 'share/pmjs/runner', runtime / 'share/pmjs/runner')
        shutil.copytree(stage / 'share/pmjs/js', runtime / 'share/pmjs/js')
        shutil.copytree(stage / 'share/pmjs/profiles', runtime / 'share/pmjs/profiles')
        tools = runtime / 'share/pmjs/tools'
        tools.mkdir()
        for tool_name in ('pmjs.mjs', 'build-js-runtime.mjs', 'game-inspect.mjs',
                          'game-bundle.mjs', 'package-self-test.cjs'):
            shutil.copy2(stage / 'share/pmjs/tools' / tool_name, tools / tool_name)
        notices = [stage / 'LICENSE', stage / 'THIRD_PARTY_NOTICES.md',
                   *sorted(file for file in (stage / 'share/pmjs/notices').rglob('*') if file.is_file())]
        with (runtime / 'LICENSES.txt').open('w') as licenses:
            for notice in notices:
                licenses.write(f'===== {notice.relative_to(stage)} =====\n\n{notice.read_text().rstrip()}\n\n')
            for notice in extra_notices:
                licenses.write(f'===== {notice.name} =====\n\n{notice.read_text().rstrip()}\n\n')
        # Only the bundled LGPL media libraries require matching source here.
        if any(file.name.startswith('libav') for file in copied):
            sources = stage / 'share/pmjs/sources'
            record = sources / 'build-records/ffmpeg.json'
            recipe = json.loads(record.read_text())['recipe']['source']
            archive = sources / ('ffmpeg-' + recipe['url'].rsplit('/', 1)[-1])
            if digest(archive) != recipe['sha256']:
                raise ValueError('Matching FFmpeg source archive is required')
            preparation = sources / 'tools/linux-arm64'
            toolchain = sources / 'cmake/toolchains/portable-arm64.cmake'
            materials = [archive, record, sources / 'build-records/toolchain.json',
                         sources / 'build-records/sysroot.json', preparation / 'prepare-sdk.py',
                         preparation / 'sdk-recipes.json', preparation / 'sdk-packages.json', toolchain]
            for file in materials:
                target = runtime / 'sources' / file.relative_to(sources)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, target)
        if not flat_runtime:
            image = port / 'runtime.squashfs'
            subprocess.run(['mksquashfs', runtime, image, '-comp', 'gzip', '-b', '131072',
                            '-noappend', '-no-progress', '-no-xattrs', '-processors', '1',
                            '-mkfs-time', str(info['source']['sourceDateEpoch']),
                            '-all-time', str(info['source']['sourceDateEpoch'])],
                           check=True, stdout=subprocess.DEVNULL)
            shutil.rmtree(runtime)
            runtime.mkdir()
        launcher = payload / (name + '.sh')
        launcher.write_text(PORTMASTER_LAUNCHER.replace('@ID@', identifier))
        launcher.chmod(0o755)
        subprocess.run(['bash', '-n', launcher], check=True)
        epoch = info['source']['sourceDateEpoch']
        package = workspace / 'game.zip'
        write_zip(payload, package, epoch)
        if inventory(stage) != info['files']:
            raise ValueError('Installed runtime changed during packaging')
        package.replace(output)
        print(f'{output} ({output.stat().st_size / 1024**2:.1f} MiB)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('stage', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--game', type=Path)
    source.add_argument('--bundle', type=Path)
    parser.add_argument('--name', help='Launcher name; defaults to the game title')
    parser.add_argument('--config', type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--patch', '--adapter', dest='adapter', type=Path, action='append', default=[],
                        help='Load a custom JavaScript patch before engine boot')
    parser.add_argument('--host-runtime', type=Path)
    parser.add_argument('--no-index', action='store_true')
    parser.add_argument('--include-assets', action='store_true')
    parser.add_argument('--strip', help='Target-capable strip executable')
    parser.add_argument('--flat-runtime', action='store_true', help='Store runtime files directly instead of gzip SquashFS')
    parser.add_argument('--notice', type=Path, action='append', default=[], help='Add a port-specific license notice')
    args = parser.parse_args()
    try:
        portmaster(args.stage.resolve(), args.game.resolve() if args.game else None, args.output.resolve(), args.name,
                   args.config.resolve() if args.config else None, [file.resolve() for file in args.adapter], args.strip,
                   args.bundle.resolve() if args.bundle else None,
                   args.host_runtime.resolve() if args.host_runtime else None,
                   args.no_index, args.include_assets, args.manifest.resolve() if args.manifest else None,
                   args.flat_runtime, [file.resolve() for file in args.notice])
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
