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

from runtime_artifact import checked_runtime, digest, elf, inventory, static_audit, strip_binary, write_json, source_reference, payload_digest


PORTMASTER_LAUNCHER = '''#!/bin/bash
entry_dir=$(cd -- "$(dirname -- "$0")" && pwd) || exit 1
runtime_pid=""
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
game="$port/gamedata"
if [ -f "$game/index.html" ]; then
  :
elif [ -f "$game/www/index.html" ]; then
  game="$game/www"
else
  found=""
  for entry in "$game"/*/www/index.html; do
    [ -f "$entry" ] || continue
    [ -z "$found" ] || { echo 'Multiple games found in gamedata; keep only one game folder'; exit 1; }
    found="${entry%/index.html}"
  done
  [ -n "$found" ] || { echo 'Missing game: copy the game folder, www folder, or its contents into gamedata'; exit 1; }
  game="$found"
fi
mkdir -p saves || exit 1
[ -w saves ] || { echo 'Save directory is not writable'; exit 1; }
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
  export XDG_CACHE_HOME="$port/.cache"
  exec "$port/runtime/bin/pmjs" "$port" --game "$game" --save-root "$port/saves" --asset-cache-root "$port/.cache"
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
            entry.compress_type = zipfile.ZIP_DEFLATED
            # ZipInfo's compression level has no public setter in Python 3.12.
            entry._compresslevel = 9
            entry.file_size = 0 if file.is_dir() else file.stat().st_size
            with bundle.open(entry, 'w') as destination:
                if not file.is_dir():
                    with file.open('rb') as source:
                        shutil.copyfileobj(source, destination, length=1024 * 1024)


def checked_bundle(bundle):
    actual = set()
    for file in bundle.rglob('*'):
        if file.is_symlink():
            raise ValueError('Bundle cannot contain symbolic links')
        if file.is_file():
            actual.add(file.relative_to(bundle).as_posix())
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
        if index.get('schema') not in (1, 2) or index.get('kind') != 'pmjs-asset-index':
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
    if actual != expected:
        raise ValueError('Bundle contains missing or undeclared files: ' +
                         ', '.join(sorted(actual.symmetric_difference(expected))[:5]))
    return descriptor


def portmaster(stage, bundle, output, name=None, strip=None, extra_notices=(), sources=None, sources_url=None):
    original_info = checked_runtime(stage)
    info = original_info
    if sources is not None or sources_url is not None:
        if sources is None or sources_url is None:
            raise ValueError('--sources and --sources-url must be provided together')
        info = {**info, 'dependencySources': source_reference(sources, sources_url)}
    if not (stage / 'bin/node').is_file():
        raise ValueError('PortMaster packaging requires a runtime with bundled target Node')
    if output.is_relative_to(stage) or output.is_relative_to(bundle):
        raise ValueError('Package output must be outside the runtime and game directories')
    if not bundle.is_dir():
        raise ValueError('Bundle directory does not exist')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pmjs-portmaster-', dir=output.parent) as temporary:
        workspace = Path(temporary)
        payload = workspace / 'payload'
        staged_bundle = workspace / 'staged-bundle'
        shutil.copytree(bundle, staged_bundle, symlinks=True)
        descriptor = checked_bundle(staged_bundle)
        if name is None:
            name = descriptor.get('title')
        if not isinstance(name, str) or not name.strip() or re.search(r'[/\\\x00-\x1f]', name) or name.strip() in ('.', '..'):
            raise ValueError('Use a nonempty game name without path separators or control characters')
        name = name.strip()
        identifier = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
        if not identifier:
            raise ValueError('Game name must contain an ASCII letter or number')
        payload.mkdir()
        port = payload / identifier
        staged_bundle.rename(port)
        runtime = port / 'runtime'
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
            inspection = elf(target, stripping=True)
            if inspection['needsStrip']:
                strip = strip or next((tool for tool in ('llvm-strip-20', 'llvm-strip', 'aarch64-linux-gnu-strip')
                                       if shutil.which(tool)), None)
                if not strip:
                    raise ValueError('Install llvm-strip or specify --strip; package binaries must be stripped')
                strip_binary(target, strip, inspection['dynamic'])
            pending.extend(stage / 'lib' / dependency for dependency in inspection['needed']
                           if (stage / 'lib' / dependency).is_file())
        static_audit(runtime, info)
        shutil.copy2(stage / 'bin/pmjs', runtime / 'bin/pmjs')
        shutil.copytree(stage / 'share/pmjs/runner', runtime / 'share/pmjs/runner')
        shutil.copytree(stage / 'share/pmjs/js', runtime / 'share/pmjs/js')
        shutil.copytree(stage / 'share/pmjs/profiles', runtime / 'share/pmjs/profiles')
        tools = runtime / 'share/pmjs/tools'
        tools.mkdir()
        for tool_name in ('pmjs.mjs', 'build-js-runtime.mjs', 'game-inspect.mjs', 'achievement-discovery.mjs',
                          'game-bundle.mjs', 'package-self-test.cjs'):
            shutil.copy2(stage / 'share/pmjs/tools' / tool_name, tools / tool_name)
        notices = [stage / 'LICENSE', stage / 'THIRD_PARTY_NOTICES.md',
                   *sorted(file for file in (stage / 'share/pmjs/notices').rglob('*') if file.is_file())]
        with (runtime / 'LICENSES.txt').open('w') as licenses:
            for notice in notices:
                licenses.write(f'===== {notice.relative_to(stage)} =====\n\n{notice.read_text().rstrip()}\n\n')
            for notice in extra_notices:
                licenses.write(f'===== {notice.name} =====\n\n{notice.read_text().rstrip()}\n\n')
            if info.get('dependencySources'):
                licenses.write('FFmpeg source and build materials: ' + info['dependencySources']['url'] + '\n')
        if any(file.name.startswith('libav') for file in copied) and not info.get('dependencySources'):
            raise ValueError('Bundled FFmpeg requires a source archive reference; specify --sources and --sources-url')
        package_info = {key: value for key, value in info.items()
                        if key not in ('files', 'compiledInputs', 'configuration', 'environment', 'loader')}
        package_info['source'] = {key: value for key, value in info['source'].items()
                                  if key in ('commit', 'dirty', 'sourceDateEpoch')}
        if 'node' in package_info:
            package_info['node'] = {key: value for key, value in info['node'].items() if key != 'source'}
        files = inventory(runtime)
        if info['schema'] == 1:
            package_info.pop('payloadSha256', None)
            # Older diagnostic scripts require the original per-file inventory.
            package_info['files'] = files
        else:
            package_info['payloadSha256'] = payload_digest(files)
        write_json(runtime / 'build-info.json', package_info)
        launcher = payload / (name + '.sh')
        launcher.write_text(PORTMASTER_LAUNCHER.replace('@ID@', identifier))
        launcher.chmod(0o755)
        subprocess.run(['bash', '-n', launcher], check=True)
        epoch = info['source']['sourceDateEpoch']
        package = workspace / 'game.zip'
        write_zip(payload, package, epoch)
        if checked_runtime(stage) != original_info:
            raise ValueError('Installed runtime changed during packaging')
        package.replace(output)
        print(f'{output} ({output.stat().st_size / 1024**2:.1f} MiB)')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('stage', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--name', help='Launcher name; defaults to the bundle title')
    parser.add_argument('--strip', help='Target-capable strip executable')
    parser.add_argument('--sources', type=Path, help='Corresponding FFmpeg source archive, distributed separately')
    parser.add_argument('--sources-url', help='Permanent HTTP(S) download URL for that archive')
    parser.add_argument('--notice', type=Path, action='append', default=[], help='Add a port-specific license notice')
    args = parser.parse_args()
    try:
        portmaster(args.stage.resolve(), args.bundle.resolve(), args.output.resolve(), args.name,
                   args.strip, [file.resolve() for file in args.notice],
                   args.sources.resolve() if args.sources else None, args.sources_url)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
