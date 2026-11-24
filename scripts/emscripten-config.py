# Emscripten configuration for the mise-managed http:emscripten release archive.
# Referenced via EM_CONFIG in mise.toml so emcc locates its bundled LLVM/Binaryen
# without putting Emscripten's clang on PATH, and honors EM_CACHE from [env].

import os
import shutil
import sys

_dir = os.path.dirname(os.path.realpath(sys.argv[0]))
while _dir and os.path.basename(_dir) != 'emscripten':
  _parent = os.path.dirname(_dir)
  if _parent == _dir:
    _dir = ''
    break
  _dir = _parent

if _dir:
  _install = os.path.dirname(_dir)
  LLVM_ROOT = os.path.join(_install, 'bin')
  BINARYEN_ROOT = _install

NODE_JS = shutil.which('node') or 'node'
