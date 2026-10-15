import hashlib
import io
import pathlib
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from provision import archive_digest, download, extract_member


def source_archive(data=b"original", *, mtime=0, mode=0o644, name="source.cpp"):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        member = tarfile.TarInfo(name)
        member.size, member.mtime, member.mode = len(data), mtime, mode
        archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


class ProvisionTests(unittest.TestCase):
    def test_archive_download_accepts_new_timestamps_with_identical_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / "source.tar.gz"
            original = source_archive(mtime=1.125)
            regenerated = source_archive(mtime=2.375)
            self.assertNotEqual(original, regenerated)
            file.write_bytes(original)
            checksum = archive_digest(file)
            file.unlink()
            with patch("urllib.request.urlopen", return_value=io.BytesIO(regenerated)):
                download("https://invalid.example/source", file, checksum, archive_contents=True)
            self.assertEqual(file.read_bytes(), regenerated)
            with patch("urllib.request.urlopen") as request:
                download("https://invalid.example/source", file, checksum, archive_contents=True)
                request.assert_not_called()

    def test_archive_checksum_rejects_duplicate_names_and_links(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / "source.tar.gz"
            for duplicate in [True, False]:
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode="w:gz") as archive:
                    archive.addfile(tarfile.TarInfo("source.cpp"), io.BytesIO())
                    member = tarfile.TarInfo("source.cpp" if duplicate else "link")
                    if not duplicate:
                        member.type, member.linkname = tarfile.SYMTYPE, "source.cpp"
                    archive.addfile(member)
                file.write_bytes(output.getvalue())
                with self.assertRaisesRegex(RuntimeError, "Duplicate|Unsupported"):
                    archive_digest(file)

    def test_archive_checksum_rejects_changed_content_names_and_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / "source.tar.gz"
            file.write_bytes(source_archive())
            checksum = archive_digest(file)
            file.unlink()
            for changed in [source_archive(b"changed"), source_archive(name="other.cpp"),
                            source_archive(mode=0o755)]:
                with self.subTest(archive=hashlib.sha256(changed).hexdigest()):
                    with patch("urllib.request.urlopen", return_value=io.BytesIO(changed)):
                        with self.assertRaisesRegex(RuntimeError, "Checksum mismatch downloading"):
                            download("https://invalid.example/source", file, checksum, archive_contents=True)
                    self.assertFalse(file.exists())
                    self.assertFalse(file.with_suffix(".gz.download").exists())
            file.write_bytes(source_archive(b"changed"))
            with patch("urllib.request.urlopen") as request:
                with self.assertRaisesRegex(RuntimeError, "Checksum mismatch in cached input"):
                    download("https://invalid.example/source", file, checksum, archive_contents=True)
                request.assert_not_called()

    def test_extraction_preserves_unchanged_inputs_and_restores_modified_source(self):
        import io
        import tarfile
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive = root / 'source.tar'
            with tarfile.open(archive, 'w') as tar:
                entry = tarfile.TarInfo('source.cpp')
                entry.size = len(b'original')
                tar.addfile(entry, io.BytesIO(b'original'))
            with tarfile.open(archive) as tar:
                member = tar.getmembers()[0]
                extract_member(tar, member, root)
                source = root / member.name
                before = source.stat().st_mtime_ns
                extract_member(tar, member, root)
                self.assertEqual(source.stat().st_mtime_ns, before)
                source.write_bytes(b'adapted')
                extract_member(tar, member, root)
                self.assertEqual(source.read_bytes(), b'original')

    def test_corrupt_cache_fails_without_network_or_replacing_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / "source.bin"
            file.write_bytes(b"changed")
            checksum = hashlib.sha256(b"original").hexdigest()
            with patch("urllib.request.urlopen") as request:
                with self.assertRaisesRegex(RuntimeError, "Checksum mismatch in cached input"):
                    download("https://invalid.example/source", file, checksum)
                request.assert_not_called()
            self.assertEqual(file.read_bytes(), b"changed")

    def test_download_mismatch_never_promotes_partial_source(self):
        import io
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / "source.bin"
            with patch("urllib.request.urlopen", return_value=io.BytesIO(b"wrong")):
                with self.assertRaisesRegex(RuntimeError, "Checksum mismatch downloading"):
                    download("https://invalid.example/source", file, hashlib.sha256(b"right").hexdigest())
            self.assertFalse(file.exists())
            self.assertFalse(file.with_suffix(".bin.download").exists())


if __name__ == "__main__":
    unittest.main()
