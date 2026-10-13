#!/usr/bin/env python3
"""Build and install PMJS without exposing the dependency preparation sequence."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def run(*args, env=None):
    subprocess.run([str(arg) for arg in args], cwd=ROOT, env=env, check=True)


def require(commands):
    missing = [name for name in commands if shutil.which(name) is None]
    if missing:
        raise ValueError("Missing build tools: " + ", ".join(missing) +
                         ". Install the host requirements in docs/building.md.")


def module_release():
    spec = importlib.util.spec_from_file_location("pmjs_release", ROOT / "tools/release.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare_arm64(jobs, env):
    require(["curl", "make", "dpkg-deb", "readelf", "clang-20", "clang++-20",
             "llvm-ar-20", "llvm-strip-20"])
    sdk = ROOT / ".cache/linux-arm64/sdk"
    node = ROOT / ".cache/linux-arm64/node"
    archive = ROOT / ".cache/effekseer/source.tar.gz"
    component = ROOT / ".cache/components/arm64"
    run(sys.executable, ROOT / "tools/linux-arm64/prepare-sdk.py",
        "--sdk", sdk, "--jobs", jobs)
    run(sys.executable, ROOT / "tools/linux-arm64/prepare-node.py", "--output", node)
    lock = json.loads((ROOT / "tools/effekseer.lock.json").read_text())
    if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != lock["sha256"]:
        archive.parent.mkdir(parents=True, exist_ok=True)
        download = archive.with_suffix(".download")
        try:
            with urllib.request.urlopen(lock["url"]) as source, download.open("wb") as target:
                shutil.copyfileobj(source, target)
            if hashlib.sha256(download.read_bytes()).hexdigest() != lock["sha256"]:
                raise ValueError("Downloaded Effekseer archive did not match its pinned SHA-256")
            download.replace(archive)
        finally:
            download.unlink(missing_ok=True)
    run(sys.executable, ROOT / "tools/skia65/build.py", "--arch", "arm64",
        "--sdk", sdk, "--output", component, "--reuse")
    env.update(PMJS_SDK_ROOT=str(sdk), PMJS_NODE_ROOT=str(node),
               PMJS_EFFEKSEER_ARCHIVE=str(archive), PMJS_SKIA65_COMPONENT_DIR=str(component))


def main():
    parser = argparse.ArgumentParser(description="Build a runnable PMJS installation")
    parser.add_argument("--target", choices=["local", "arm64"], default="local")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 4))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    if sys.platform != "linux":
        parser.error("PMJS builds require Linux")
    require(["cmake", "ninja", "pkg-config", "git", "python3"])
    output = (args.output or ROOT / "dist" /
              ("pmjs-arm64" if args.target == "arm64" else "pmjs")).resolve()
    if output in (ROOT, ROOT / "build", ROOT / "dist"):
        parser.error("output must be an installation directory")
    release = module_release()
    if output.exists():
        if output.is_symlink():
            raise ValueError(f"Output cannot be a symbolic link: {output}")
        if not output.is_dir():
            raise ValueError(f"Output is not a directory: {output}")
        if any(output.iterdir()):
            if not (output / "build-info.json").is_file():
                raise ValueError(f"Output contains unrelated files: {output}")
            try:
                release.checked_manifest(output)
            except (OSError, ValueError, KeyError) as error:
                raise ValueError(f"Output is not a complete PMJS installation: {output}") from error
    env = os.environ.copy()
    preset = "dev"
    if args.target == "arm64":
        run(sys.executable, ROOT / "tools/build.py", "--target", "local", "--jobs", args.jobs)
        prepare_arm64(args.jobs, env)
        preset = "release-linux-arm64"
    else:
        require(["c++", "node"])
        packages = ("sdl2", "egl", "glesv2", "libpng", "libwebp", "zlib", "libjpeg",
                    "freetype2", "harfbuzz", "libavformat", "libavcodec", "libavutil",
                    "libswresample", "libswscale")
        missing = [package for package in packages if subprocess.run(
            ["pkg-config", "--exists", package], check=False).returncode != 0]
        if missing:
            raise ValueError("Missing native development libraries: " + ", ".join(missing) +
                             ". See docs/building.md.")
    build_dir = ROOT / "build" / ("pmjs-arm64" if args.target == "arm64" else "dev")
    run("cmake", "--preset", preset, "-B", build_dir, "-DBUILD_TESTING=OFF", env=env)
    run("cmake", "--build", build_dir, "--target", "pmjs_native",
        "--parallel", args.jobs, env=env)
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = output.parent / f".{output.name}.stage-{os.getpid()}"
    backup = output.parent / f".{output.name}.previous-{os.getpid()}"
    try:
        stage.mkdir()
        run("cmake", "--install", build_dir, "--prefix", stage, env=env)
        release.checked_manifest(stage)
        if output.exists():
            output.rename(backup)
        try:
            stage.rename(output)
        except BaseException:
            if backup.exists():
                backup.rename(output)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    print(f"PMJS installed: {output / 'bin/pmjs'}")
    if args.target == "arm64":
        print("ARM64 runtime is ready; run this executable on the target device.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"build: {error}", file=sys.stderr)
        sys.exit(1)
