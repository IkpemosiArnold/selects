#!/bin/sh
# Compile the faces tool (macOS only; needs swiftc from Xcode or the Command Line Tools).
set -e
dir="$(cd "$(dirname "$0")" && pwd)"
if ! command -v swiftc >/dev/null 2>&1; then
  echo "faces/build.sh: swiftc not found. Install the Command Line Tools with: xcode-select --install" >&2
  exit 1
fi
swiftc -O "$dir/faces.swift" -o "$dir/faces"
echo "built $dir/faces"
