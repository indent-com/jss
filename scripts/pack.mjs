#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const output = resolve(process.argv[2] ?? 'artifacts');
mkdirSync(output, { recursive: true });
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], { encoding: 'utf8' }));
const bytes = readFileSync(join(output, filename));
function resolveSourceRevision() {
  if (process.env.JSS_SOURCE_REVISION !== undefined) return process.env.JSS_SOURCE_REVISION;
  try {
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (status !== '') return '';
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const sourceRevision = resolveSourceRevision();
const metadata = {
  schemaVersion: 1,
  name: manifest.name,
  version: manifest.version,
  repository: 'https://github.com/indent-com/jss',
  tarball: filename,
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  engine: { name: 'quickjs-ng', version: '0.16.2', commit: '1ab8676f4b6d6d669baeb5f21790fb9734636a20' },
  toolchain: { node: process.version, emscripten: execFileSync('emcc', ['--version'], { encoding: 'utf8' }).split('\n')[0] },
  ...(sourceRevision ? { sourceRevision } : {}),
};
writeFileSync(join(output, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(join(output, filename));
