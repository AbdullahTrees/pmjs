"""Incremental native builds and installation provenance using a compiled fixture."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import release


class BuildProvenance(unittest.TestCase):
    def setUp(self):
        temporary_root = ROOT / '.cache/tests'
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs build provenance ', dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for directory in ('src', 'cmake', 'tools', 'third_party', 'docs', 'js', 'runner', 'profiles', 'bin', 'test', 'dependencies'):
            (self.root / directory).mkdir()
        for source in ('tools/release.py', 'cmake/Install.cmake', 'cmake/build-config.json.in'):
            shutil.copy2(ROOT / source, self.root / source)
        for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md', 'third_party/effekseer.LICENSE',
                     'third_party/effekseer-mz.patch', 'tools/effekseer.lock.json'):
            (self.root / name).write_text('fixture')
        (self.root / 'bin/pmjs').write_text('#!/bin/sh\nexit 0\n')
        for name in ('build-js-runtime.mjs', 'game-inspect.mjs', 'game-bundle.mjs', 'pmjs.mjs',
                     'package-self-test.cjs', 'portmaster.py', 'linux-arm64/audit-abi.py'):
            (self.root / 'tools' / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / 'tools' / name).write_text('// fixture\n')
        (self.root / '.gitignore').write_text('build/\ndist/\ndependencies/\n')
        (self.root / 'docs/using.md').write_text('Original documentation\n')
        (self.root / 'src/value.h').write_text('#define VALUE 10\n')
        (self.root / 'dependencies/provider.h').write_text('#define HEADER_VALUE 20\n')
        self.provider(1)
        (self.root / 'src/runtime.cpp').write_text('int runtime() { return 0; }\n')
        (self.root / 'src/addon.cpp').write_text(
            '#include "value.h"\n#include "provider.h"\nextern "C" int provider();\n'
            'extern "C" int value() { return VALUE + HEADER_VALUE + provider(); }\n')
        (self.root / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.20)
project(fixture VERSION 0.1.0 LANGUAGES C CXX)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
add_library(pmjs_runtime STATIC src/runtime.cpp)
add_library(Effekseer STATIC EXCLUDE_FROM_ALL src/runtime.cpp)
add_library(EffekseerRendererGL STATIC EXCLUDE_FROM_ALL src/runtime.cpp)
add_library(pmjs_native MODULE src/addon.cpp)
target_include_directories(pmjs_native PRIVATE dependencies)
target_link_libraries(pmjs_native PRIVATE pmjs_runtime "${CMAKE_SOURCE_DIR}/dependencies/libprovider.so")
set_target_properties(pmjs_native PROPERTIES PREFIX "" SUFFIX ".node" INSTALL_RPATH "$ORIGIN")
set(PNG_LINK_LIBRARIES "${CMAKE_SOURCE_DIR}/dependencies/libprovider.so")
set(PMJS_RELEASE_PROVENANCE ON CACHE BOOL "")
install(FILES dependencies/libprovider.so DESTINATION lib)
include(cmake/Install.cmake)
''')
        self.command('git', 'init', '-q', str(self.root))
        self.command('git', '-C', str(self.root), 'add', '.')
        self.command('git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'Fixture')
        self.build = self.root / 'build'
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release')
        self.compile()

    def command(self, *args, success=True, env=None):
        result = subprocess.run(args, text=True, capture_output=True, env=env)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def provider(self, value):
        subprocess.run(['cc', '-shared', '-fPIC', '-x', 'c', '-', '-o', str(self.root / 'dependencies/libprovider.so')],
                       input=f'int provider(void) {{ return {value}; }}', text=True, check=True)

    def compile(self):
        return self.command('cmake', '--build', str(self.build), '--target', 'pmjs_native')

    def install(self, name, success=True):
        destination = self.root / 'dist' / name
        result = self.command('cmake', '--install', str(self.build), '--prefix', str(destination), success=success)
        return destination, result

    def test_distribution_edits_do_not_reconfigure_or_relink(self):
        addon = self.build / 'pmjs_native.node'
        before = (addon.read_bytes(), addon.stat().st_mtime_ns, (self.build / 'build-source.json').read_bytes())
        first, _ = self.install('first')
        for name in ('docs/using.md', 'js/module.js', 'test/check.cjs'):
            (self.root / name).write_text('Changed distribution content\n')
        result = self.compile()
        self.assertNotIn('Re-running CMake', result.stdout)
        self.assertNotIn('Linking', result.stdout)
        self.assertEqual(before, (addon.read_bytes(), addon.stat().st_mtime_ns,
                                  (self.build / 'build-source.json').read_bytes()))
        second, _ = self.install('second')
        old = json.loads((first / 'build-info.json').read_text())
        new = json.loads((second / 'build-info.json').read_text())
        self.assertNotEqual(old['source']['sourceSha256'], new['source']['sourceSha256'])
        self.assertNotEqual(old['files']['share/pmjs/docs/using.md'], new['files']['share/pmjs/docs/using.md'])
        self.assertEqual(old['compiledInputs'], new['compiledInputs'])

    def test_native_headers_libraries_flags_and_binary_are_checked(self):
        for index, (file, text) in enumerate([
            ('src/value.h', '#define VALUE 11\n'),
            ('dependencies/provider.h', '#define HEADER_VALUE 21\n')
        ]):
            (self.root / file).write_text(text)
            _, rejected = self.install(f'rejected-header-{index}', success=False)
            self.assertIn('Native inputs or binary changed', rejected.stdout + rejected.stderr)
            self.compile()
            self.install(f'header-{index}')
        self.provider(2)
        self.install('rejected-library', success=False)
        result = self.compile()
        self.assertIn('Linking', result.stdout)
        self.install('library')
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-DCMAKE_CXX_FLAGS=-DFIXTURE=1')
        self.install('rejected-flags', success=False)
        self.compile()
        self.install('flags')
        addon = self.build / 'pmjs_native.node'
        with addon.open('ab') as file:
            file.write(b'tampered')
        self.install('rejected-binary', success=False)

    def test_build_id_is_saved_at_install_without_relinking(self):
        addon = self.build / 'pmjs_native.node'
        before = (addon.read_bytes(), addon.stat().st_mtime_ns)
        for name, build_id in [('named', 'build-2026-10-15-abc1234-123-1'), ('local', '')]:
            destination = self.root / 'dist' / name
            self.command('cmake', '--install', str(self.build), '--prefix', str(destination),
                         env={**os.environ, 'PMJS_BUILD_ID': build_id})
            info = json.loads((destination / 'build-info.json').read_text())
            self.assertEqual(info['buildId'], build_id or None)
        self.assertEqual(before, (addon.read_bytes(), addon.stat().st_mtime_ns))
        for build_id in ('has spaces', 'build\nforged-log-line'):
            result = self.command('cmake', '--install', str(self.build), '--prefix', str(self.root / 'dist/invalid'),
                                  env={**os.environ, 'PMJS_BUILD_ID': build_id}, success=False)
            self.assertIn('PMJS_BUILD_ID must use', result.stdout + result.stderr)

    def test_release_strips_installed_binaries_before_verification(self):
        node = self.root / 'dependencies/node'
        (node / 'bin').mkdir(parents=True)
        (node / 'LICENSE').write_text('fixture license')
        subprocess.run(['cc', '-g', '-x', 'c', '-', '-o', node / 'bin/node'],
                       input='int main(void) { return 0; }', text=True, check=True)
        self.command('cmake', '-S', str(self.root), '-B', str(self.build),
                     '-DCMAKE_CXX_FLAGS=-g', '-DPMJS_NODE_ROOT=' + str(node))
        self.compile()
        originals = [self.build / 'pmjs_native.node', node / 'bin/node',
                     self.root / 'dependencies/libprovider.so']
        before = [file.read_bytes() for file in originals]
        self.assertIn('.debug_info', self.command('readelf', '-S', '--wide', str(originals[0])).stdout)
        stage, _ = self.install('stripped')
        for source, relative in zip(originals, ('lib/pmjs_native.node', 'bin/node', 'lib/libprovider.so')):
            target = stage / relative
            sections = self.command('readelf', '-S', '--wide', str(target)).stdout
            self.assertNotIn('.debug', sections)
            self.assertNotIn('.symtab', sections)
            self.assertEqual(self.command('readelf', '--dyn-syms', '--wide', str(source)).stdout,
                             self.command('readelf', '--dyn-syms', '--wide', str(target)).stdout)
        self.assertEqual([file.read_bytes() for file in originals], before)
        self.assertEqual(ctypes.CDLL(str(stage / 'lib/pmjs_native.node')).value(), 31)
        self.command(str(stage / 'bin/node'))
        info = release.checked_manifest(stage)
        report = self.root / 'verification.json'
        release.verify(stage, report, static=True)
        output = self.root / 'archives/pmjs-linux-x64-1234567.tar.gz'
        release.archive(stage, report, output, development=True)
        self.assertEqual(list(output.parent.iterdir()), [output])
        with tarfile.open(output) as archive:
            self.assertEqual(archive.extractfile('pmjs-linux-x64/lib/pmjs_native.node').read(),
                             (stage / 'lib/pmjs_native.node').read_bytes())
        self.assertEqual(info['files'], release.inventory(stage))

    def test_debug_installation_keeps_symbols(self):
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-DCMAKE_BUILD_TYPE=Debug')
        self.compile()
        stage, _ = self.install('debug')
        self.assertIn('.debug_info', self.command('readelf', '-S', '--wide',
                                                 str(stage / 'lib/pmjs_native.node')).stdout)

    def test_installation_rejects_strip_tool_that_leaves_symbols(self):
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-DCMAKE_STRIP=/bin/true')
        self.compile()
        _, result = self.install('not-stripped', success=False)
        self.assertIn('Strip tool left debug information', result.stdout + result.stderr)

    def test_separate_sources_preserves_runtime_and_matching_build_materials(self):
        stage, _ = self.install('with-sources')
        sources = stage / 'share/pmjs/sources'
        (sources / 'build-records').mkdir(parents=True)
        source_archive = sources / 'ffmpeg-fixture.tar.xz'
        source_archive.write_bytes(b'original matching media source')
        release.write_json(sources / 'build-records/ffmpeg.json',
                           {'recipe': {'source': {'url': 'https://example.invalid/fixture.tar.xz',
                                                  'sha256': release.digest(source_archive)}}})
        for name in ('tools/linux-arm64/prepare-sdk.py', 'cmake/toolchains/portable-arm64.cmake'):
            file = sources / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('matching build material\n')
        info = json.loads((stage / 'build-info.json').read_text())
        info['files'] = release.inventory(stage)
        release.write_json(stage / 'build-info.json', info)
        before = {str(file.relative_to(sources)): file.read_bytes()
                  for file in sources.rglob('*') if file.is_file()}
        package = self.root / 'archives/pmjs-ffmpeg-sources-1234567.tar.gz'
        url = 'https://example.invalid/releases/download/build-fixture/' + package.name
        self.command(sys.executable, str(self.root / 'tools/release.py'), 'separate-sources',
                     '--stage', str(stage), '--output', str(stage / 'sources.tar.gz'), '--url', url, success=False)
        self.assertEqual(release.checked_manifest(stage), info)
        self.command(sys.executable, str(self.root / 'tools/release.py'), 'separate-sources',
                     '--stage', str(stage), '--output', str(package), '--url', url)
        self.assertFalse(sources.exists())
        runtime = release.checked_manifest(stage)
        self.assertEqual(runtime['files'], {name: entry for name, entry in info['files'].items()
                                           if not name.startswith('share/pmjs/sources/')})
        self.assertEqual(runtime['compiledInputs'], info['compiledInputs'])
        self.assertEqual(runtime['dependencySources'],
                         {'filename': package.name, 'sha256': release.digest(package), 'url': url})
        with tarfile.open(package) as bundle:
            prefix = 'pmjs-ffmpeg-sources/'
            members = {member.name.removeprefix(prefix): member for member in bundle if member.isfile()}
            self.assertEqual(set(members), {*before, 'build-info.json'})
            for name in before:
                self.assertEqual(bundle.extractfile(members[name]).read(), before[name])
            self.assertEqual(json.load(bundle.extractfile(members['build-info.json'])), info)
        report = self.root / 'static.json'
        release.verify(stage, report, static=True)
        release.archive(stage, report, self.root / 'archives/runtime.tar.gz', development=True)


class DependencySources(unittest.TestCase):
    def setUp(self):
        temporary_root = ROOT / '.cache/tests'
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs dependency sources ', dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ('tools/release.py', 'tools/linux-arm64/sdk-recipes.json',
                     'tools/linux-arm64/sdk-packages.json', 'tools/linux-arm64/prepare-sdk.py',
                     'cmake/toolchains/portable-arm64.cmake'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        self.cache = self.root / 'downloads'
        self.cache.mkdir()
        spec_file = self.root / 'tools/linux-arm64/sdk-recipes.json'
        spec = json.loads(spec_file.read_text())
        self.archive = self.cache / spec['sources']['ffmpeg']['url'].rsplit('/', 1)[-1]
        self.archive.write_bytes(b'matching media source archive')
        spec['sources']['ffmpeg']['sha256'] = release.digest(self.archive)
        release.write_json(spec_file, spec)
        self.sdk = self.root / 'sdk'
        (self.sdk / 'records').mkdir(parents=True)
        for component in ('ffmpeg', 'toolchain', 'sysroot'):
            release.write_json(self.sdk / 'records' / (component + '.json'), {'component': component})
        self.output = self.root / 'installed sources'

    def sources(self):
        return subprocess.run([sys.executable, self.root / 'tools/release.py', 'sources',
                               '--sdk', self.sdk, '--output', self.output], text=True, capture_output=True,
                              env={**os.environ, 'PMJS_DOWNLOAD_CACHE': str(self.cache)})

    def test_only_media_sources_are_shipped_with_rebuild_materials(self):
        result = self.sources()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual({str(file.relative_to(self.output)) for file in self.output.rglob('*') if file.is_file()},
                         {'ffmpeg-' + self.archive.name,
                          'tools/linux-arm64/sdk-recipes.json', 'tools/linux-arm64/sdk-packages.json',
                          'tools/linux-arm64/prepare-sdk.py', 'cmake/toolchains/portable-arm64.cmake',
                          'build-records/ffmpeg.json', 'build-records/toolchain.json', 'build-records/sysroot.json'})
        self.assertEqual((self.output / ('ffmpeg-' + self.archive.name)).read_bytes(), self.archive.read_bytes())
        self.assertEqual((self.output / 'cmake/toolchains/portable-arm64.cmake').read_bytes(),
                         (ROOT / 'cmake/toolchains/portable-arm64.cmake').read_bytes())

    def test_missing_or_changed_media_sources_are_rejected(self):
        for content in (b'changed source archive', None):
            with self.subTest(content=content):
                if content is None:
                    self.archive.unlink()
                else:
                    self.archive.write_bytes(content)
                result = self.sources()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Missing verified dependency source archive', result.stderr)
                self.assertFalse((self.output / ('ffmpeg-' + self.archive.name)).exists())


if __name__ == '__main__':
    unittest.main()
