#!/usr/bin/env python3
"""Stage, verify and archive the exact installed runtime, with build provenance."""
import argparse
import gzip
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from runtime_artifact import checked_runtime, recognize_runtime, digest, inventory, static_audit, strip_binary, strip_binaries, write_json, source_reference, payload_digest

ROOT = Path(__file__).resolve().parent.parent


def git(source, *args):
    return subprocess.check_output(['git', '-C', source, *args])


def source_identity(source, required=True):
    if not required:
        return {'commit': 'unqualified', 'dirty': True, 'sourceSha256': None,
                'sourceDateEpoch': 0, 'files': {}}
    names = git(source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0')
    files = {os.fsdecode(name): digest(source / os.fsdecode(name)) for name in sorted(set(names))
             if name and (source / os.fsdecode(name)).is_file()}
    return {'commit': git(source, 'rev-parse', 'HEAD').decode().strip(),
            'dirty': bool(git(source, 'status', '--porcelain', '--untracked-files=normal').strip()),
            'sourceSha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(),
            'sourceDateEpoch': int(git(source, 'show', '-s', '--format=%ct', 'HEAD').decode()),
            'files': files}


def cache_values(build):
    values = {}
    for line in (build / 'CMakeCache.txt').read_text().splitlines():
        match = re.match(r'([^:#/][^:]*):[^=]+=(.*)', line)
        if match:
            values[match[1]] = match[2]
    return values


NATIVE_TARGET = r'CMakeFiles/(?:pmjs_native|pmjs_runtime|pmjs_lz4|astcenc-(?:neon|sse2|none)-static|Effekseer|EffekseerRendererGL)\.dir/'


def compiled_identity(source, build):
    commands = [item for item in json.loads((build / 'compile_commands.json').read_text())
                if re.search(NATIVE_TARGET, item.get('command', item.get('output', '')))]
    if not commands:
        raise ValueError('No native compilation commands found')
    files = {Path(item['file']).resolve() for item in commands}
    values = cache_values(build)
    # CMake's generated link command defines native settings and imported libraries.
    # Bookkeeping commands after the link do not affect the resulting ELF.
    output = subprocess.check_output([values['CMAKE_MAKE_PROGRAM'], '-C', build,
                                      '-t', 'commands', 'pmjs_native.node'], text=True)
    links = []
    for line in output.splitlines():
        lexer = shlex.shlex(line, posix=True, punctuation_chars=';&')
        lexer.whitespace_split = True
        command = []
        for token in [*lexer, '&&']:
            if token in ('&&', ';'):
                if '-c' not in command and any(re.search(NATIVE_TARGET, part) for part in command):
                    links.append(command)
                command = []
            else:
                command.append(token)
    if not links:
        raise ValueError('No native link command found')
    # Read graph edges as well: CMake can spell a linked library as -L/-l.
    query = subprocess.check_output([values['CMAKE_MAKE_PROGRAM'], '-C', build,
                                     '-t', 'query', 'pmjs_native.node'], text=True)
    for line in query.partition('\n  input:')[2].partition('\n  outputs:')[0].splitlines()[1:]:
        file = Path(line.lstrip(' |'))
        if file.is_absolute() and file.is_file() and re.search(r'\.(?:a|so(?:\.[0-9]+)*)$', file.name):
            files.add(file)
    # Cross-compiler wrappers invoke the SDK compiler recorded by CMake.
    files.update(Path(line) for line in (build / 'build-inputs.txt').read_text().splitlines() if line)
    files.update(Path(values[key]) for key in ('CMAKE_C_COMPILER', 'CMAKE_CXX_COMPILER', 'CMAKE_AR', 'CMAKE_LINKER')
                 if values.get(key) and Path(values[key]).is_file())
    return {'files': {str(file): digest(file) for file in sorted(files)},
            'commands': sorted(commands, key=lambda item: item['file']),
            'linkCommands': links}


def compiled_dependencies(build):
    values = cache_values(build)
    if values.get('CMAKE_GENERATOR') != 'Ninja':
        raise ValueError('Release provenance requires the Ninja generator used by the CMake presets')
    dependencies = subprocess.check_output([values['CMAKE_MAKE_PROGRAM'], '-C', build, '-t', 'deps'], text=True)
    files, native = set(), False
    for line in dependencies.splitlines():
        if line.startswith('    '):
            if native:
                file = Path(line[4:])
                files.add(file.resolve() if file.is_absolute() else (build / file).resolve())
        else:
            native = bool(re.search(NATIVE_TARGET, line))
    if not files:
        raise ValueError('No completed native compiler dependencies found')
    return {str(file): digest(file) for file in sorted(files)}


def manifest(stage, build, source, strip=None, record=None, sources=None, sources_url=None):
    build_id = os.environ.get('PMJS_BUILD_ID') or None
    if build_id is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', build_id):
        raise ValueError('PMJS_BUILD_ID must use letters, numbers, dots, underscores or hyphens and start with a letter or number')
    if recognize_runtime(stage)['schema'] != 2:
        raise ValueError('Restage the runtime with the current installer before detached qualification')
    record = record or release_record(stage)
    if record.is_relative_to(stage):
        raise ValueError('Release record must be outside the runtime')
    if (sources is None) != (sources_url is None):
        raise ValueError('--sources and --sources-url must be provided together')
    reference = source_reference(sources, sources_url) if sources else None
    if sources and sources.parent != record.parent:
        raise ValueError('Keep the source archive alongside the detached release record')
    if any((stage / 'share/pmjs' / name).exists() for name in ('docs', 'sources')) or any(
            (stage / 'share/pmjs/tools' / name).exists() for name in
            ('portmaster.py', 'release.py', 'runtime_artifact.py', 'linux-arm64')):
        raise ValueError('Use a runtime-only installation for qualification (release.py stage)')
    if any((stage / 'lib').glob('libav*.so*')) and reference is None:
        raise ValueError('Bundled FFmpeg requires --sources and --sources-url')
    config = json.loads((build / 'build-config.json').read_text())
    values = cache_values(build)
    qualified = values.get('PMJS_RELEASE_PROVENANCE') == 'ON'
    identity = source_identity(source, qualified)
    if qualified:
        # Apply edited CMake logic before comparing its effective native commands.
        subprocess.run(['cmake', '-S', source, '-B', build], check=True)
        configured = json.loads((build / 'build-source.json').read_text())
        compiled = json.loads((build / 'build-compiled.json').read_text())
        inputs = compiled_identity(source, build)
        if (inputs != configured or compiled['inputs'] != inputs or
                compiled['dependencies'] != compiled_dependencies(build) or
                compiled['addonSha256'] != digest(build / 'pmjs_native.node')):
            raise ValueError('Native inputs or binary changed since compilation; build again before installation')
        # Installation can rewrite RPATH. Compare the exact form produced by
        # CMake, rather than comparing it with the uninstalled build output.
        with tempfile.TemporaryDirectory(prefix='.pmjs-install-check-', dir=build) as directory:
            subprocess.run(['cmake', '--install', build, '--prefix', directory,
                            '--component', 'native-addon'], check=True)
            expected = Path(directory) / 'lib/pmjs_native.node'
            installed_hash = digest(stage / 'lib/pmjs_native.node')
            expected_hash = digest(expected)
            if installed_hash != expected_hash and strip:
                # Requalification accepts the exact stripped installation too.
                # Transform only the fresh reference, never normalize an unknown
                # installed binary into something that could hide modification.
                strip_binary(expected, strip)
                expected_hash = digest(expected)
            if installed_hash != expected_hash:
                raise ValueError('Installed addon differs from the compiled release output; stage it again')
    if strip:
        strip_binaries(stage, strip)
    files = inventory(stage)
    info = {**config, 'schema': 2, 'buildId': build_id,
            'source': {key: identity[key] for key in ('commit', 'dirty', 'sourceDateEpoch')},
            'compiledProvenance': qualified,
            'node': {'bundled': (stage / 'bin/node').exists(), 'minimumNodeApi': 8},
            'payloadSha256': payload_digest(files)}
    if reference:
        info['dependencySources'] = reference
    details = {'schema': 1, 'source': identity, 'compiledProvenance': qualified, 'files': files,
               'configuration': {key: value for key, value in values.items()
                                 if key in ('CMAKE_C_FLAGS', 'CMAKE_CXX_FLAGS', 'PMJS_ENABLE_SANITIZERS',
                                            'PMJS_ENABLE_WERROR', 'PMJS_OFFLINE', 'BUILD_TESTING')},
               'loader': static_audit(stage, info)}
    if qualified:
        details['compiledInputs'] = compiled
    if config['targetEnvironment'] == 'ON':
        details['environment'] = {'recipes': json.loads((ROOT / 'tools/linux-arm64/sdk-recipes.json').read_text()),
                                  'packages': json.loads((ROOT / 'tools/linux-arm64/sdk-packages.json').read_text())}
        details['nodeSource'] = json.loads((ROOT / 'tools/linux-arm64/node.json').read_text())
    write_json(stage / 'build-info.json', info)
    write_json(record, {**details, 'packageSha256': digest(stage / 'build-info.json')})


def release_record(stage):
    return stage.parent / (stage.name + '.release.json')


def checked_manifest(stage, record=None):
    location = record or release_record(stage)
    if not location.is_file():
        raise ValueError('Release inventory missing; use release.py stage or manifest first')
    details = json.loads(location.read_text())
    if not isinstance(details.get('files'), dict):
        raise ValueError('Release inventory missing from detached record')
    info = checked_runtime(stage, files=details['files'])
    if details.get('schema') != 1 or details.get('packageSha256') != digest(stage / 'build-info.json'):
        raise ValueError('Release record belongs to a different runtime')
    if info.get('dependencySources'):
        reference = info['dependencySources']
        name = reference['filename']
        if not isinstance(name, str) or Path(name).name != name or name in ('', '.', '..'):
            raise ValueError('Invalid source archive filename')
        source = (record or release_record(stage)).parent / name
        if digest(source) != reference['sha256']:
            raise ValueError('Source archive differs from the release reference')
    static_audit(stage, info)
    return {**info, **details, 'node': {**info['node'], **(
            {'source': details['nodeSource']} if 'nodeSource' in details else {})}}


def archive_sources(sdk, output, epoch=0):
    from dependencies import sources
    subprocess.run([sys.executable, ROOT / 'tools/linux-arm64/prepare-sdk.py', '--sdk', sdk, '--verify'], check=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.pmjs-sources-', dir=output.parent) as directory:
        materials = Path(directory) / 'sources'
        sources(sdk, materials)
        temporary = Path(directory) / 'sources.tar.gz'
        def normalized(entry):
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = ''
            entry.mtime = epoch
            return entry
        with temporary.open('wb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=epoch) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.GNU_FORMAT) as bundle:
                bundle.add(materials, arcname='pmjs-ffmpeg-sources', filter=normalized)
        source_reference(temporary)
        temporary.replace(output)
    print('FFmpeg source and build materials:', output)


def checked_smoke(info, package_hash, smoke):
    architecture = 'arm64' if info['architecture'] in ('aarch64', 'arm64') else 'x64'
    if (smoke.get('schema') != 1 or smoke.get('status') != 'passed' or not smoke.get('load') or
            smoke.get('packageSha256') != package_hash or smoke.get('architecture') != architecture or
            smoke.get('platform') != 'linux' or smoke.get('nodeApi', 0) < 8 or
            smoke.get('verifiedFiles') != len(info['files'])):
        raise ValueError('Smoke receipt does not verify this exact package')
    if info['node'].get('source') and smoke.get('node') != 'v' + info['node']['source']['version']:
        raise ValueError('Smoke receipt used a different Node release')


def verify(stage, report, graphics=False, xvfb=False, receipt=None, static=False, record=None):
    record = record or release_record(stage)
    record_bytes = record.read_bytes()
    record_hash = hashlib.sha256(record_bytes).hexdigest()
    info = checked_manifest(stage, record)
    package_hash = digest(stage / 'build-info.json')
    if receipt:
        smoke = json.loads(receipt.read_text())
    elif static:
        smoke = None
    else:
        # Every execution uses a fresh copy and an environment without build-library paths.
        with tempfile.TemporaryDirectory(prefix='.pmjs-relocated-', dir=stage.parent) as directory:
            relocated = Path(directory) / 'runtime'
            shutil.copytree(stage, relocated)
            environment = {key: value for key, value in os.environ.items()
                           if key not in ('LD_LIBRARY_PATH', 'NODE_PATH', 'NODE_OPTIONS', 'PMJS_NATIVE_ADDON')}
            environment['SDL_AUDIODRIVER'] = 'dummy'
            environment['PMJS_WINDOW_SIZE'] = '32x24'
            environment.pop('PMJS_TEXT_BACKEND', None)
            command = [str(relocated / 'bin/pmjs'), 'self-test'] + (['--graphics'] if graphics else [])
            if xvfb:
                command = ['xvfb-run', '-a', *command]
                environment['LIBGL_ALWAYS_SOFTWARE'] = '1'
            process = subprocess.run(command, cwd=directory, env=environment, text=True,
                                     capture_output=True, timeout=120)
            if process.returncode:
                raise ValueError('Relocated smoke test failed:\n' + process.stdout + process.stderr)
            smoke = json.loads(process.stdout.strip().splitlines()[-1])
    if smoke:
        checked_smoke(info, package_hash, smoke)
    if (inventory(stage) != info['files'] or digest(stage / 'build-info.json') != package_hash or
            digest(record) != record_hash):
        raise ValueError('Package or release record changed during verification')
    if info.get('dependencySources') and digest(record.parent / info['dependencySources']['filename']) != info['dependencySources']['sha256']:
        raise ValueError('Source archive changed during verification')
    write_json(report, {'schema': 2, 'packageSha256': package_hash, 'releaseRecordSha256': record_hash,
                        'static': 'passed', 'smoke': smoke,
                        'source': info['source']['commit']})
    print('Package verified:', report)


def checked_verification(info, verification, package_hash, record_hash, development):
    if verification.get('schema') != 2 or verification.get('packageSha256') != package_hash:
        raise ValueError('Verification report belongs to a different package')
    if verification.get('releaseRecordSha256') != record_hash:
        raise ValueError('Verification report belongs to a different release record')
    smoke = verification.get('smoke')
    if verification.get('static') != 'passed':
        raise ValueError('Static package verification is required before archiving')
    if not development and (not smoke or not smoke.get('load')):
        raise ValueError('An executed smoke test is required before archiving')
    if smoke:
        checked_smoke(info, verification['packageSha256'], smoke)
    if not development and not (smoke.get('graphics') or {}).get('renderer'):
        raise ValueError('Public releases require a graphics smoke receipt for runtime initialization, rendering and shutdown')
    if not development and info['architecture'] in ('aarch64', 'arm64'):
        gpu = smoke.get('graphics')
        if not gpu or re.search(r'llvmpipe|softpipe|swiftshader', gpu.get('renderer', ''), re.I):
            raise ValueError('ARM64 releases require a graphics smoke receipt from a hardware renderer')
        if smoke.get('textBackend') != 'skia65':
            raise ValueError('ARM64 releases require the intended Skia65 text backend')
    if info['source']['dirty'] and not development:
        raise ValueError('Public releases require a clean source tree; --development creates a development candidate')
    if not info.get('compiledProvenance') and not development:
        raise ValueError('Public releases require compiled source provenance')


def archive(stage, report, output, development=False, record=None):
    record = record or release_record(stage)
    record_bytes = record.read_bytes()
    record_hash = hashlib.sha256(record_bytes).hexdigest()
    info = checked_manifest(stage, record)
    verification = json.loads(report.read_text())
    checked_verification(info, verification, digest(stage / 'build-info.json'), record_hash, development)
    output.parent.mkdir(parents=True, exist_ok=True)
    epoch = info['source']['sourceDateEpoch']
    inputs = [record, report]
    if info.get('dependencySources'):
        inputs.append(record.parent / info['dependencySources']['filename'])
    if output.is_relative_to(stage) or output in inputs:
        raise ValueError('Archive output must be outside the runtime and its verification inputs')
    with tempfile.TemporaryDirectory(prefix='.pmjs-archive-', dir=output.parent) as directory:
        temporary = Path(directory) / output.name
        with temporary.open('wb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=epoch) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.GNU_FORMAT) as bundle:
                name = 'pmjs-linux-' + ('arm64' if info['architecture'] in ('arm64', 'aarch64') else 'x64')
                for file in [stage, *sorted(stage.rglob('*'))]:
                    entry = bundle.gettarinfo(str(file), arcname=str(Path(name) / file.relative_to(stage)))
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ''
                    entry.mtime = epoch
                    if entry.isfile():
                        with file.open('rb') as payload:
                            bundle.addfile(entry, payload)
                    else:
                        bundle.addfile(entry)
        if (inventory(stage) != info['files'] or verification['packageSha256'] != digest(stage / 'build-info.json') or
                digest(record) != record_hash):
            temporary.unlink()
            raise ValueError('Package or release record changed while archiving')
        if info.get('dependencySources'):
            source = record.parent / info['dependencySources']['filename']
            if digest(source) != info['dependencySources']['sha256']:
                temporary.unlink()
                raise ValueError('Source archive changed while archiving')
        if info.get('dependencySources'):
            destination = output.parent / source.name
            if destination != source:
                if destination.exists() and digest(destination) != info['dependencySources']['sha256']:
                    raise ValueError('A different source archive already exists at the output location')
                if not destination.exists():
                    copied_source = Path(directory) / source.name
                    shutil.copyfile(source, copied_source)
                    if digest(copied_source) != info['dependencySources']['sha256']:
                        raise ValueError('Source archive changed during export')
                    copied_source.replace(destination)
        # Each companion is bound by checksum; publish the archive after its records.
        archived_record = Path(directory) / (output.name + '.release.json')
        archived_record.write_bytes(record_bytes)
        archived_report = Path(directory) / (output.name + '.verification.json')
        write_json(archived_report,
                   {**verification, 'distribution': 'development' if development else 'release',
                    'archive': {'filename': output.name, 'sha256': digest(temporary)},
                    'dependencySources': info.get('dependencySources')})
        archived_record.replace(output.with_name(archived_record.name))
        archived_report.replace(output.with_name(archived_report.name))
        temporary.replace(output)
    print('Development archive:' if development else 'Verified release archive:', output)


def verify_archive(output, record=None, report=None):
    record = record or output.with_name(output.name + '.release.json')
    report = report or output.with_name(output.name + '.verification.json')
    verification = json.loads(report.read_text())
    if verification.get('archive') != {'filename': output.name, 'sha256': digest(output)}:
        raise ValueError('Archive differs from its verification record')
    record_hash = digest(record)
    if verification.get('releaseRecordSha256') != record_hash:
        raise ValueError('Verification report belongs to a different release record')
    if verification.get('distribution') not in ('development', 'release'):
        raise ValueError('Unknown archive distribution type')
    with tempfile.TemporaryDirectory(prefix='.pmjs-archive-check-', dir=output.parent) as directory:
        with tarfile.open(output) as bundle:
            members = bundle.getmembers()
            names = set()
            roots = set()
            for member in members:
                parts = member.name.split('/')
                if (not member.isfile() and not member.isdir()) or any(part in ('', '.', '..') for part in parts) or '\\' in member.name:
                    raise ValueError('Archive must contain regular runtime files and directories')
                if member.name in names:
                    raise ValueError('Duplicate runtime archive path')
                names.add(member.name)
                roots.add(parts[0])
            if len(roots) != 1 or not roots <= {'pmjs-linux-x64', 'pmjs-linux-arm64'}:
                raise ValueError('Archive must contain exactly one runtime directory')
            bundle.extractall(directory, filter='data')
            for member in members:
                if member.isfile():
                    os.chmod(Path(directory) / member.name, member.mode & 0o777)
        stage = Path(directory) / roots.pop()
        info = checked_manifest(stage, record)
        if verification.get('dependencySources') != info.get('dependencySources'):
            raise ValueError('Archive source reference differs from runtime metadata')
        checked_verification(info, verification, digest(stage / 'build-info.json'), record_hash,
                             verification['distribution'] == 'development')
    if digest(output) != verification['archive']['sha256'] or digest(record) != record_hash:
        raise ValueError('Archive or release record changed during verification')
    print('Archive and detached records verified:', output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('provenance')
    command.add_argument('--source', type=Path, required=True)
    command.add_argument('--build', type=Path, required=True)
    command = commands.add_parser('built')
    command.add_argument('--source', type=Path, required=True)
    command.add_argument('--build', type=Path, required=True)
    command.add_argument('--addon', type=Path, required=True)
    command = commands.add_parser('manifest')
    for name in ['stage', 'build', 'source']:
        command.add_argument('--' + name, type=Path, required=True)
    command.add_argument('--strip', help='Strip installed binaries with this target-capable executable')
    command = commands.add_parser('stage')
    command.add_argument('--build', type=Path, required=True)
    command.add_argument('--output', type=Path, required=True)
    command = commands.add_parser('sources')
    command.add_argument('--sdk', type=Path, required=True)
    command.add_argument('--output', type=Path, required=True)
    command.add_argument('--epoch', type=int, default=0)
    command = commands.add_parser('verify')
    command.add_argument('--stage', type=Path, required=True)
    command.add_argument('--report', type=Path, required=True)
    command.add_argument('--graphics', action='store_true')
    command.add_argument('--xvfb', action='store_true')
    modes = command.add_mutually_exclusive_group()
    modes.add_argument('--receipt', type=Path)
    modes.add_argument('--static', action='store_true')
    command = commands.add_parser('archive')
    for name in ['stage', 'report', 'output']:
        command.add_argument('--' + name, type=Path, required=True)
    command.add_argument('--development', action='store_true', help='Create a candidate without public release qualification')
    command = commands.add_parser('verify-archive')
    command.add_argument('--archive', type=Path, required=True)
    command.add_argument('--record', type=Path)
    command.add_argument('--report', type=Path)
    for name in ('manifest', 'stage', 'verify', 'archive'):
        commands.choices[name].add_argument('--record', type=Path, help='Detached release record; defaults to RUNTIME.release.json alongside the runtime')
    for name in ('manifest', 'stage'):
        commands.choices[name].add_argument('--sources', type=Path, help='Corresponding source archive alongside the release record')
        commands.choices[name].add_argument('--sources-url', help='Permanent HTTP(S) source archive download URL')
    args = parser.parse_args()
    try:
        if args.command == 'provenance':
            write_json(args.build / 'build-source.json', compiled_identity(args.source.resolve(), args.build.resolve()))
        elif args.command == 'built':
            configured = json.loads((args.build / 'build-source.json').read_text())
            if configured != compiled_identity(args.source.resolve(), args.build.resolve()):
                raise ValueError('Native inputs changed while compiling; build again')
            write_json(args.build / 'build-compiled.json',
                       {'inputs': configured, 'dependencies': compiled_dependencies(args.build.resolve()),
                        'addonSha256': digest(args.addon.resolve())})
        elif args.command == 'manifest':
            manifest(args.stage.resolve(), args.build.resolve(), args.source.resolve(), args.strip,
                     args.record.resolve() if args.record else None,
                     args.sources.resolve() if args.sources else None, args.sources_url)
        elif args.command == 'sources':
            archive_sources(args.sdk.resolve(), args.output.resolve(), args.epoch)
        elif args.command == 'stage':
            if args.output.exists() and any(args.output.iterdir()):
                raise ValueError('Use an empty staging directory to avoid carrying old release files')
            subprocess.run(['cmake', '--build', args.build.resolve(), '--target', 'pmjs_native', '--parallel', '4'], check=True)
            for component in ('native-addon', 'runtime'):
                subprocess.run(['cmake', '--install', args.build.resolve(), '--prefix', args.output.resolve(),
                                '--component', component], check=True)
            values = cache_values(args.build.resolve())
            tool = None
            if values.get('CMAKE_BUILD_TYPE') in ('Release', 'MinSizeRel'):
                tool = 'llvm-strip-20' if values.get('PMJS_LINUX_ARM64_BUILD') == 'ON' else values.get('CMAKE_STRIP')
            manifest(args.output.resolve(), args.build.resolve(), ROOT, tool,
                     args.record.resolve() if args.record else None,
                     args.sources.resolve() if args.sources else None, args.sources_url)
        elif args.command == 'verify':
            verify(args.stage.resolve(), args.report.resolve(), args.graphics, args.xvfb, args.receipt, args.static, args.record.resolve() if args.record else None)
        elif args.command == 'verify-archive':
            verify_archive(args.archive.resolve(), args.record.resolve() if args.record else None,
                           args.report.resolve() if args.report else None)
        elif args.command == 'archive':
            archive(args.stage.resolve(), args.report.resolve(), args.output.resolve(), args.development, args.record.resolve() if args.record else None)
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
