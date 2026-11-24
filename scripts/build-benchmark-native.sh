#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

out="${1:-$PWD/.cache/benchmark-native/jss-benchmark-native}"
mkdir -p "$(dirname "$out")"

cc_bin="${CC:-cc}"
if ! command -v "$cc_bin" >/dev/null 2>&1; then
  printf 'benchmark-native: C compiler %q not found on PATH\n' "$cc_bin" >&2
  exit 1
fi

"$cc_bin" -std=c11 -O3 -DNDEBUG -D_GNU_SOURCE -DQUICKJS_NG_BUILD -funsigned-char \
  -Ivendor/quickjs benchmarks/native.c \
  vendor/quickjs/quickjs.c vendor/quickjs/dtoa.c \
  vendor/quickjs/libregexp.c vendor/quickjs/libunicode.c \
  -lm -pthread -o "$out"

printf '%s\n' "$out"
