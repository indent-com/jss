#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
url=https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.16.2.tar.gz
digest=97c80625b26775a4c7ca618c004d4ea24cf99cbf867e4eba78bd927a8b23d106
curl --fail --location --retry 3 "$url" --output "$stage/source.tar.gz"
printf '%s  %s\n' "$digest" "$stage/source.tar.gz" | sha256sum --check --status
mkdir "$stage/quickjs"
tar -xzf "$stage/source.tar.gz" -C "$stage/quickjs" --strip-components=1
cp vendor/quickjs/UPSTREAM.md "$stage/quickjs/UPSTREAM.md"
rm -rf vendor/quickjs
mv "$stage/quickjs" vendor/quickjs
printf '%s\n' 'Vendored quickjs-ng v0.16.2; verified archive SHA-256.'
