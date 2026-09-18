#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ${1-} != '' && ${1-} != '--engine-only' ]]; then
  printf 'Usage: npm run build -- [--engine-only]\n' >&2
  exit 2
fi
mkdir -p .cache
jss_build_stage=$(mktemp -d "$PWD/.cache/build.XXXXXX")
trap 'rm -rf "$jss_build_stage"' EXIT
export JSS_BUILD_DIR="$jss_build_stage"
mkdir -p "$jss_build_stage/engine"
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const source = readFileSync("bridge/codec.js", "utf8");
  if (/[^\x00-\x7f]/.test(source)) throw new Error("Bridge codec must remain ASCII for C embedding");
  const text = source.split("\n").map(line => JSON.stringify(line + "\n")).join("\n") + "\n";
  writeFileSync("bridge/codec.inc", text);
'
export EM_CACHE=${EM_CACHE:-"$(pwd)/.cache/emscripten"}
mkdir -p "$EM_CACHE"
emcc \
  -std=c11 -Oz -DNDEBUG -D_GNU_SOURCE -DQUICKJS_NG_BUILD -funsigned-char \
  -Ivendor/quickjs \
  vendor/quickjs/quickjs.c vendor/quickjs/dtoa.c \
  vendor/quickjs/libregexp.c vendor/quickjs/libunicode.c bridge/engine.c \
  --no-entry \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker \
  -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=268435456 \
  -sSTACK_SIZE=2097152 -sSTACK_OVERFLOW_CHECK=2 -sABORTING_MALLOC=0 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_jss_create","_jss_command","_jss_jobs","_jss_events","_jss_output_length","_jss_output_count","_jss_output_data","_jss_output_size","_jss_release_output","_jss_dispose"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -sINCOMING_MODULE_JS_API='["wasmBinary","locateFile","onAbort","print","printErr"]' \
  -o "$jss_build_stage/engine/quickjs.js"
if [[ ${1-} != '--engine-only' ]]; then
  node_modules/.bin/tsc --outDir "$jss_build_stage"
fi
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  import { execFileSync } from "node:child_process";
  const info = { engine: "quickjs-ng", version: "0.16.2", commit: "1ab8676f4b6d6d669baeb5f21790fb9734636a20", emscripten: execFileSync("emcc", ["--version"], {encoding:"utf8"}).split("\n")[0] };
  writeFileSync(process.env.JSS_BUILD_DIR + "/engine/build.json", JSON.stringify(info, null, 2) + "\n");
'
# Commit completed output only; emcc may leave an intermediate WASM on failure.
node --input-type=module - "${1-}" <<'JS'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
const stage = process.env.JSS_BUILD_DIR;
const engineOnly = process.argv[2] === '--engine-only';
const destination = engineOnly ? 'dist/engine' : 'dist';
const source = engineOnly ? `${stage}/engine` : stage;
const previous = `${stage}-previous`;
if (engineOnly) mkdirSync('dist', {recursive:true});
const hadPrevious = existsSync(destination);
if (hadPrevious) renameSync(destination, previous);
try { renameSync(source, destination); }
catch (error) { if (hadPrevious) renameSync(previous, destination); throw error; }
rmSync(previous, {recursive:true, force:true});
JS
