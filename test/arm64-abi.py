import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('arm64_abi', ROOT / 'tools/linux-arm64/audit-abi.py')
abi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(abi)


class LoaderContractTests(unittest.TestCase):
    def audit(self, needed, **requirements):
        def inspect(file):
            versions = {name: [] for name in ('GLIBC', 'GLIBCXX', 'CXXABI', 'GCC', 'LIBATOMIC')}
            if file.name == 'node':
                versions.update(requirements)
            return {'path': str(file), 'needed': needed if file.name == 'node' else [],
                    'requirements': versions}
        with patch.object(abi, 'inspect', side_effect=inspect):
            return abi.audit(ROOT / 'bin/node', ROOT / 'lib/pmjs_native.node', Path(__file__).parent)

    def test_atomic_runtime_is_an_explicit_system_dependency(self):
        report = self.audit(['libatomic.so.1'], LIBATOMIC=['1.0'])
        self.assertEqual(report['systemLibraries'], ['libatomic.so.1'])

    def test_other_missing_dependencies_still_require_bundling(self):
        with self.assertRaisesRegex(ValueError, 'missing bundled dependency libexample.so.1'):
            self.audit(['libexample.so.1'])

    def test_atomic_and_existing_abi_ceilings_remain_enforced(self):
        for namespace, value in [('LIBATOMIC', '1.1'), ('GLIBC', '2.29'),
                                 ('GLIBCXX', '3.4.22'), ('CXXABI', '1.3.12')]:
            with self.subTest(namespace=namespace), self.assertRaisesRegex(ValueError, 'maximum is'):
                self.audit(['libatomic.so.1'], **{namespace: [value]})


if __name__ == '__main__':
    unittest.main()
