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
const metadata = {
  schemaVersion: 1,
  name: manifest.name,
  version: manifest.version,
  repository: 'https://github.com/indent-com/jss',
  tarball: filename,
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  engine: { name: 'quickjs-ng', version: '0.16.2', commit: '1ab8676f4b6d6d669baeb5f21790fb9734636a20' },
  toolchain: { node: process.version, emscripten: execFileSync('emcc', ['--version'], { encoding: 'utf8' }).split('\n')[0] },
  ...(process.env.JSS_SOURCE_REVISION ? { sourceRevision: process.env.JSS_SOURCE_REVISION } : {}),
};
writeFileSync(join(output, 'release.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(join(output, filename));
