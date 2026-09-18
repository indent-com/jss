import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { inspectTarball, validateArtifact } from '../bin/publish';

const root = fileURLToPath(new URL('../', import.meta.url));
const publisher = join(root, 'bin/publish');
const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function archive(entries) {
  const blocks = [];
  for (const [name, data, type = '0'] of entries) {
    const body = Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156);
    header.write('ustar\0', 257); header.write('00', 263);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function fixture(t, { manifest = packageManifest, transform = entries => entries, metadata: overrides = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'jss-publish-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entries = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/design.md',
    'dist/node.js', 'dist/browser.js', 'dist/node-worker.js', 'dist/browser-worker.js',
    'dist/engine/quickjs.js', 'dist/node.d.ts', 'dist/browser.d.ts'].map(path => [`package/${path}`, '// fixture\n']);
  entries.push(['package/package.json', JSON.stringify(manifest)],
    ['package/dist/engine/quickjs.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])]);
  const bytes = archive(transform(entries));
  const artifact = join(directory, `indent-com-jss-${manifest.version}.tgz`);
  writeFileSync(artifact, bytes);
  const metadata = {
    schemaVersion: 1, name: manifest.name, version: manifest.version,
    repository: 'https://github.com/indent-com/jss', tarball: artifact.slice(directory.length + 1),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    engine: { name: 'quickjs-ng', version: '0.16.2', commit: '1ab8676f4b6d6d669baeb5f21790fb9734636a20' },
    toolchain: { node: process.version, emscripten: 'fixture' }, ...overrides,
  };
  writeFileSync(join(directory, 'release.json'), JSON.stringify(metadata));
  return artifact;
}

test('publisher accepts a portable complete archive and normalized Git repository', t => {
  const result = validateArtifact(fixture(t));
  assert.equal(result.manifest.name, '@indent-com/jss');
  assert.equal(result.fileCount, 13);
  assert.match(result.integrity, /^sha512-/);
});

for (const [name, entries, message] of [
  ['path traversal', [['package/../escape', 'evil']], /Unsafe archive path/],
  ['symbolic links', [['package/dist/link.js', '', '2']], /no links/],
  ['hard links', [['package/dist/link.js', '', '1']], /no links/],
  ['duplicate files', [['package/README.md', 'a'], ['package/README.md', 'b']], /Duplicate/],
  ['native artifacts', [['package/dist/addon.node', 'native']], /Unexpected distribution/],
  ['unlisted files', [['package/secret.env', 'secret']], /Unexpected package/],
]) {
  test(`publisher rejects ${name}`, () => assert.throws(() => inspectTarball(archive(entries)), message));
}

test('publisher detects mutated tarball bytes', t => {
  const artifact = fixture(t);
  writeFileSync(artifact, 'tampered');
  assert.throws(() => validateArtifact(artifact), /SHA-512/);
});

test('publisher requires packaged workers and every export target', t => {
  const missingWorker = fixture(t, { transform: entries => entries.filter(([name]) => name !== 'package/dist/browser-worker.js') });
  assert.throws(() => validateArtifact(missingWorker), /Missing or empty packaged file/);
  const missingTypes = fixture(t, { transform: entries => entries.filter(([name]) => name !== 'package/dist/node.d.ts') });
  assert.throws(() => validateArtifact(missingTypes), /Missing or invalid exported asset/);
});

test('publisher rejects runtime dependencies, install scripts and wrong registries', t => {
  for (const [patch, expected] of [
    [{ dependencies: { unexpected: '1.0.0' } }, /runtime npm dependencies/],
    [{ scripts: { install: 'echo unexpected' } }, /Installation lifecycle/],
    [{ publishConfig: { access: 'public', registry: 'https://example.invalid/' } }, /publishConfig/],
  ]) assert.throws(() => validateArtifact(fixture(t, { manifest: { ...packageManifest, ...patch } })), expected);
});

test('publisher rejects store references and mismatched engine provenance', t => {
  const reference = fixture(t, { transform: entries => entries.map(([name, body]) => [name, name === 'package/dist/node.js' ? 'import "/nix/store/nonportable.js"' : body]) });
  assert.throws(() => validateArtifact(reference), /Nonportable Nix store/);
  const engine = fixture(t, { metadata: { engine: { name: 'quickjs-ng', version: 'unknown', commit: 'bad' } } });
  assert.throws(() => validateArtifact(engine), /engine provenance/);
});

test('GitHub Actions publication still requires a release tag before registry access', t => {
  const artifact = fixture(t);
  const result = spawnSync(publisher, ['--artifact', artifact], {
    env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'indent-com/jss',
      GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'branch' }, encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Publishing requires a pushed release tag/);
});

function simulatedPublisher(t, { metadata, manifest = packageManifest } = {}) {
  const artifact = fixture(t, { metadata, manifest });
  const directory = dirname(artifact), bin = join(directory, 'bin'), log = join(directory, 'commands.jsonl');
  mkdirSync(bin);
  mkdirSync(join(directory, 'elsewhere'));
  mkdirSync(join(directory, 'result'));
  writeFileSync(join(directory, 'result', 'stale.tgz'), 'not the new artifact');
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  copyFileSync(publisher, join(bin, 'publish'));
  chmodSync(join(bin, 'publish'), 0o755);
  for (const tool of ['nix', 'npm', 'git']) {
    const program = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const tool = ${JSON.stringify(tool)}, args = process.argv.slice(2);
const entry = { tool, args, cwd: process.cwd(),
  nodeToken: Boolean(process.env.NODE_AUTH_TOKEN), npmToken: Boolean(process.env.NPM_TOKEN) };
if (tool === 'npm' && args[0] === 'publish') entry.stdin = readFileSync(0, 'utf8');
appendFileSync(process.env.PUBLISH_TEST_LOG, JSON.stringify(entry) + '\\n');
if (tool === 'nix') {
  if (process.env.PUBLISH_TEST_BUILD_FAIL) { console.error('fixture build failed'); process.exit(7); }
  console.log(process.env.PUBLISH_TEST_OUTPUT);
} else if (tool === 'git') {
  if (args[0] === 'rev-parse') console.log('a'.repeat(40));
} else if (args[0] === '--version') console.log('11.6.0');
else if (args[0] === 'view') {
  if (process.env.PUBLISH_TEST_EXISTING) console.log(JSON.stringify(process.env.PUBLISH_TEST_EXISTING));
  else { console.log(JSON.stringify({ error: { code: 'E404' } })); process.exit(1); }
} else if (args[0] === 'publish') console.log('fixture publish succeeded');
else throw new Error('Unexpected command');
`;
    writeFileSync(join(bin, tool), program, { mode: 0o755 });
  }
  return {
    artifact, directory,
    run(args = [], env = {}) {
      return spawnSync('publish', args, {
        cwd: join(directory, 'elsewhere'), encoding: 'utf8', timeout: 10_000,
        input: 'fixture-otp\n',
        env: { ...process.env, GITHUB_ACTIONS: 'false',
          NODE_AUTH_TOKEN: 'fixture-node-token', NPM_TOKEN: 'fixture-npm-token',
          PATH: [bin, dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
          PUBLISH_TEST_LOG: log, PUBLISH_TEST_OUTPUT: directory, ...env },
      });
    },
    calls() { return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); },
  };
}

test('plain publish builds the current Nix artifact and publishes locally with npm auth and terminal input', t => {
  const fixture = simulatedPublisher(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Published @indent-com\/jss@/);
  const calls = fixture.calls();
  assert.deepEqual(calls.map(call => call.tool), ['nix', 'npm', 'npm']);
  assert.deepEqual(calls[0].args, ['build', '.#npm', '--no-update-lock-file', '--no-link', '--print-out-paths']);
  assert.equal(calls[0].cwd, fixture.directory);
  const tag = packageManifest.version.includes('-') ? 'next' : 'latest';
  assert.deepEqual(calls[2].args, ['publish', fixture.artifact, '--ignore-scripts', '--access', 'public', '--tag', tag, '--registry', 'https://registry.npmjs.org/']);
  assert.equal(calls[2].nodeToken, true);
  assert.equal(calls[2].npmToken, true);
  assert.equal(calls[2].stdin, 'fixture-otp\n');
});

test('publish dry-run builds automatically and keeps npm offline', t => {
  const fixture = simulatedPublisher(t);
  const result = fixture.run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const calls = fixture.calls();
  assert.deepEqual(calls.map(call => call.tool), ['nix', 'npm']);
  assert.deepEqual(calls[1].args.slice(-2), ['--dry-run', '--offline']);
});

test('an explicit artifact skips Nix for local publishing', t => {
  const fixture = simulatedPublisher(t);
  const result = fixture.run(['--artifact', fixture.artifact]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.calls().map(call => call.tool), ['npm', 'npm']);
});

test('a failed automatic build never reaches npm', t => {
  const fixture = simulatedPublisher(t);
  const result = fixture.run([], { PUBLISH_TEST_BUILD_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture build failed/);
  assert.deepEqual(fixture.calls().map(call => call.tool), ['nix']);
});

test('local publishing retains registry integrity checks for existing versions', t => {
  const fixture = simulatedPublisher(t);
  const metadata = JSON.parse(readFileSync(join(fixture.directory, 'release.json'), 'utf8'));
  const result = fixture.run([], { PUBLISH_TEST_EXISTING: metadata.integrity });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /identical artifact is already published/);
  assert.deepEqual(fixture.calls().map(call => call.args[0]), ['build', 'view']);
});

test('CI publishes the supplied artifact with OIDC provenance and no rebuild', t => {
  const revision = 'a'.repeat(40);
  const fixture = simulatedPublisher(t, { metadata: { sourceRevision: revision } });
  const tag = `v${packageManifest.version}`;
  const result = fixture.run(['--artifact', fixture.artifact], {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'indent-com/jss', GITHUB_EVENT_NAME: 'push',
    GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag, GITHUB_REF: `refs/tags/${tag}`, GITHUB_SHA: revision,
    RUNNER_ENVIRONMENT: 'github-hosted', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-oidc-token',
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = fixture.calls();
  assert.ok(!calls.some(call => call.tool === 'nix'));
  const publish = calls.find(call => call.tool === 'npm' && call.args[0] === 'publish');
  assert.equal(publish.args.at(-1), '--provenance');
  assert.equal(publish.nodeToken, false);
  assert.equal(publish.npmToken, false);
});

test('prereleases cannot use latest and dist-tags cannot resemble versions', t => {
  const artifact = fixture(t, { manifest: { ...packageManifest, version: '0.1.0-beta.1' } });
  for (const [tag, expected] of [['latest', /prerelease may never/], ['1.2.3', /Dist-tag/]]) {
    const result = spawnSync(publisher, ['--artifact', artifact, '--dry-run', '--tag', tag], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }
});

test('standalone publish runs from PATH in another directory and validates offline without registry writes', { timeout: 15_000 }, t => {
  const artifact = fixture(t, { manifest: { ...packageManifest, version: '0.1.0-beta.1' } });
  const bin = join(dirname(artifact), 'bin');
  const elsewhere = join(dirname(artifact), 'elsewhere');
  mkdirSync(bin);
  mkdirSync(elsewhere);
  copyFileSync(publisher, join(bin, 'publish'));
  chmodSync(join(bin, 'publish'), 0o755);
  const result = spawnSync('publish', ['--artifact', artifact, '--dry-run'], {
    cwd: elsewhere,
    env: {
      ...process.env,
      PATH: [bin, dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
      GITHUB_ACTIONS: 'false',
      npm_config_cache: join(dirname(artifact), 'npm-cache'),
    },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dist-tag: next/);
  assert.match(result.stdout, /provenance are not verified/);
  assert.match(result.stdout, /No registry write/);
});
