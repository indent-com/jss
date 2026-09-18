#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) throw new Error('Usage: node test/package.mjs ARTIFACT.tgz');
const artifact = resolve(process.argv[2]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(join(tmpdir(), 'jss-package-'));
try {
  writeFileSync(join(fixture, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--prefix', fixture, artifact], { stdio: 'inherit' });
  const installed = join(fixture, 'node_modules/@indent-com/jss');
  cpSync(installed, join(fixture, 'installed'), { recursive: true });
  cpSync(join(root, 'test'), join(fixture, 'installed/test'), { recursive: true });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { evaluate, createSandbox } from '@indent-com/jss';
    if (await evaluate('6 * 7') !== 42) throw new Error('Package import/evaluation failed');
    const sandbox = await createSandbox({execution:'inline'});
    try { if (await sandbox.evaluate('40 + 2') !== 42) throw new Error('Inline failed'); }
    finally { await sandbox.dispose(); }
  `], { cwd: fixture, stdio: 'inherit' });
  const tests = readdirSync(join(fixture, 'installed/test')).filter(file => file.endsWith('.test.mjs') && file !== 'publish.test.mjs').map(file => `test/${file}`);
  execFileSync(process.execPath, ['--test', ...tests], { cwd: join(fixture, 'installed'), stdio: 'inherit' });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
