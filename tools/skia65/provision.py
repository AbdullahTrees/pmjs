#!/usr/bin/env python3
"""Provision the release's private raster sources, verifying every download."""
import concurrent.futures
import hashlib
import json
import pathlib
import shutil
import tarfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
LOCK = pathlib.Path(__file__).with_name("sources.lock.json")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive_digest(path):
    # Gitiles generates fresh PAX timestamps for each download of the same commit.
    # Pin the complete source tree without those generated archive attributes.
    records = {}
    with tarfile.open(path) as source:
        for member in source:
            if member.name in records:
                raise RuntimeError(f"Duplicate source archive entry: {member.name}")
            if member.isfile():
                with source.extractfile(member) as payload:
                    content = hashlib.file_digest(payload, "sha256").hexdigest()
                records[member.name] = ["file", member.mode, content]
            elif member.isdir():
                records[member.name] = ["directory", member.mode]
            else:
                raise RuntimeError(f"Unsupported source archive entry: {member.name}")
    return hashlib.sha256(json.dumps(records, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def extract_member(source, member, destination):
    # Verify extracted bytes against the archive on every invocation, while
    # preserving mtimes for unchanged compiler inputs. GN adaptations are
    # restored from the pinned input rather than becoming source authority.
    member = tarfile.data_filter(member, destination)
    if member is None:
        return
    target = destination / member.name
    if member.isfile() and target.is_file() and not target.is_symlink():
        with source.extractfile(member) as original:
            if target.read_bytes() == original.read():
                return
    source.extract(member, destination, filter="data")


def download(url, destination, checksum, *, archive_contents=False):
    checksum_of = archive_digest if archive_contents else digest
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if checksum_of(destination) != checksum:
            raise RuntimeError(f"Checksum mismatch in cached input: {destination}")
        return
    temporary = destination.with_suffix(destination.suffix + ".download")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "pmjs-skia65"})
        with urllib.request.urlopen(request, timeout=60) as source, temporary.open("wb") as output:
            shutil.copyfileobj(source, output)
        if checksum_of(temporary) != checksum:
            raise RuntimeError(f"Checksum mismatch downloading {url}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def provision(cache):
    lock = json.loads(LOCK.read_text())
    cache.mkdir(parents=True, exist_ok=True)
    # Always compare with verified archives, including existing source trees.
    for archive in lock["archives"]:
        filename = cache / (archive["name"] + ".tar.gz")
        if "contentSha256" in archive:
            download(archive["url"], filename, archive["contentSha256"], archive_contents=True)
        else:
            download(archive["url"], filename, archive["sha256"])
        with tarfile.open(filename) as source:
            for member in source.getmembers():
                parts = pathlib.PurePosixPath(member.name).parts[archive["strip"]:]
                if not parts:
                    continue
                member.name = str(pathlib.PurePosixPath(archive["name"], *parts))
                extract_member(source, member, cache)
    chromium = cache / "chromium"
    base = "https://raw.githubusercontent.com/nwjs/chromium.src/" + lock["chromium"] + "/"

    def fetch(entry):
        download(base + entry["path"], chromium / entry["path"], entry["sha256"])

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
        list(workers.map(fetch, lock["files"]))
    tools = cache / "tools"
    tools.mkdir(exist_ok=True)
    for tool in lock["tools"]:
        archive = cache / (tool["name"] + (".zip" if "zipMember" in tool else ".bin"))
        download(tool["url"], archive, tool["sha256"])
        executable = tools / tool["name"]
        if "zipMember" in tool:
            with zipfile.ZipFile(archive) as source:
                executable.write_bytes(source.read(tool["zipMember"]))
        else:
            shutil.copyfile(archive, executable)
        executable.chmod(0o755)
    (cache / "provision.json").write_text(json.dumps({
        "lockSha256": digest(LOCK), "dependencies": lock,
    }, indent=2) + "\n")
    return lock


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=pathlib.Path, default=ROOT / ".cache/skia65")
    provision(parser.parse_args().cache.resolve())
