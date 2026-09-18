#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(join(tmpdir(), 'jss-browser-'));
const consumer = join(fixture, 'consumer');
const publicRoot = join(fixture, 'public');
mkdirSync(consumer); mkdirSync(publicRoot);
writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
const installed = join(consumer, 'node_modules/@indent-com/jss');
const browsers = { chromium, firefox, webkit };
const requested = (process.env.JSS_BROWSERS ?? 'chromium').split(',');
for (const name of requested) assert.ok(browsers[name], `Unknown JSS_BROWSERS entry: ${name}`);

// Independent of the browser event loop: a broken inline interrupt cannot hang CI.
const watchdog = setTimeout(() => {
  console.error('Browser integration exceeded the 180-second external watchdog');
  process.exit(1);
}, 180_000);
let server;
let activeBrowser;
try {
  if (process.argv[2]) {
    const artifact = resolve(process.argv[2]);
    execFileSync('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--omit=dev', '--prefix', consumer, artifact], { stdio: 'inherit' });
  } else {
    mkdirSync(installed, { recursive: true });
    cpSync(join(root, 'dist'), join(installed, 'dist'), { recursive: true });
    cpSync(join(root, 'package.json'), join(installed, 'package.json'));
  }
  mkdirSync(join(publicRoot, 'direct'));
  writeFileSync(join(publicRoot, 'direct/index.html'), '<!doctype html><meta charset="utf-8"><title>jss native ESM integration</title><script type="module">import * as jss from "/pkg/dist/browser.js"; globalThis.jss = jss;</script>');
  mkdirSync(join(publicRoot, 'relocated'));
  cpSync(join(installed, 'dist/engine/quickjs.wasm'), join(publicRoot, 'relocated/quickjs.wasm'));
  writeFileSync(join(consumer, 'index.html'), '<!doctype html><meta charset="utf-8"><title>jss Vite production integration</title><script type="module" src="/main.js"></script>');
  writeFileSync(join(consumer, 'main.js'), 'import * as jss from "@indent-com/jss"; globalThis.jss = jss;\n');
  await build({
    configFile: false, root: consumer, base: '/nested/base/', logLevel: 'warn',
    build: { outDir: join(publicRoot, 'nested/base'), emptyOutDir: true },
  });

  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const base = pathname.startsWith('/pkg/') ? installed : publicRoot;
      const relative = pathname.startsWith('/pkg/') ? pathname.slice(5) : pathname.slice(1);
      const file = resolve(base, relative.endsWith('/') ? `${relative}index.html` : relative);
      if (!file.startsWith(`${base}${sep}`) || !existsSync(file)) { response.writeHead(404); response.end('missing'); return; }
      const data = readFileSync(file);
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(data);
    } catch { response.writeHead(500); response.end('server error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  for (const name of requested) {
    activeBrowser = await browsers[name].launch({ headless: true });
    const context = await activeBrowser.newContext();
    const externalRequests = [];
    const assetResponses = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { externalRequests.push(url.href); await route.abort(); }
      else await route.continue();
    });
    context.on('response', response => {
      if (response.url().includes('.wasm')) assetResponses.push({ url: response.url(), status: response.status(), mime: response.headers()['content-type'] });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    for (const path of ['/direct/', '/nested/base/']) {
      await page.goto(`${origin}${path}`);
      await page.waitForFunction(() => globalThis.jss !== undefined);
      const result = await page.evaluate(async () => {
        const { createSandbox, evaluate } = globalThis.jss;
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const rejection = async (promise, expected) => {
          try { await promise; } catch (error) {
            if (expected) check(error.code === expected, `Expected ${expected}, got ${error.code}: ${error.message}`);
            return;
          }
          throw new Error(`Expected rejection ${expected ?? ''}`);
        };
        check(!crossOriginIsolated, 'Test must run without cross-origin isolation');
        const verified = [];
        for (const execution of ['inline', 'worker']) {
          const sandbox = await createSandbox({ execution, timeoutMs: 2_000 });
          try {
            check(await sandbox.evaluate('6 * 7') === 42, `${execution} evaluation`);
            check(await sandbox.evaluate('await Promise.resolve(40) + 2') === 42, `${execution} top-level await`);
            await sandbox.set('payload', { word: '\ud800\0', large: 2n ** 90n, bytes: new Uint8Array([1, 2, 3]) });
            const copied = await sandbox.get('payload');
            check(copied.word === '\ud800\0' && copied.large === 2n ** 90n && copied.bytes instanceof Uint8Array && copied.bytes[2] === 3, `${execution} copied values`);
            const binary = Uint8Array.from({ length: 65_536 }, (_, i) => i & 255);
            await sandbox.expose('echoBinary', value => value);
            await sandbox.set('binary', binary.subarray(3, 65_533));
            const echoed = await sandbox.evaluate('await echoBinary({ bytes: binary, marker: { $jssBytes: 0 } })');
            check(binary.byteLength === 65_536 && echoed.bytes.byteOffset === 0 && echoed.bytes.buffer.byteLength === 65_530,
              `${execution} binary ownership`);
            check(echoed.marker.$jssBytes === 0 && echoed.bytes.every((value, i) => value === ((i + 3) & 255)), `${execution} binary attachments`);
            await sandbox.expose('lookup', async id => ({ id, answer: 42 }));
            check(await sandbox.evaluate('(await lookup("x")).answer') === 42, `${execution} callback`);
            await sandbox.expose('reenter', async () => await sandbox.evaluate('42'));
            check(await sandbox.evaluate('await reenter()') === 42, `${execution} callback reentrancy`);
            const handle = await sandbox.evaluateHandle('({ value: 40, plus(n) { return this.value + n } })');
            const answer = await handle.invoke('plus', [2]);
            check(await answer.dump() === 42, `${execution} handle`);
            await answer.dispose(); await handle.dispose();
            await rejection(sandbox.evaluate('throw new Error("expected")'), 'ERR_GUEST');
            check(await sandbox.evaluate('42') === 42, `${execution} recovery after guest error`);
            if (execution === 'inline') {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 25);
              try {
                await rejection(sandbox.evaluate('await new Promise(() => { function again() { Promise.resolve().then(again) } again() })', {
                  signal: controller.signal, timeoutMs: 2_000,
                }), 'ERR_ABORTED');
              } finally { clearTimeout(timer); }
              check(sandbox.disposed, 'Inline job traffic must yield for host cancellation');
            }
          } finally { await sandbox.dispose(); }
          verified.push(execution);
        }
        check(await evaluate('42') === 42, 'default execution');

        const responsive = await createSandbox({ execution: 'worker' });
        let timerRan = false;
        const loop = rejection(responsive.evaluate('while (true) {}', { timeoutMs: 400 }), 'ERR_TIMEOUT');
        await new Promise(resolve => setTimeout(() => { timerRan = true; resolve(); }, 20));
        check(timerRan && !responsive.disposed, 'Parent timer must run while guest worker is busy');
        await loop;
        check(responsive.disposed, 'Timeout must retire sandbox');
        await responsive.dispose();

        const cancelable = await createSandbox();
        const controller = new AbortController();
        const aborted = rejection(cancelable.evaluate('while (true) {}', { timeoutMs: 5_000, signal: controller.signal }), 'ERR_ABORTED');
        setTimeout(() => controller.abort(), 25);
        await aborted;
        check(cancelable.disposed, 'Abort must retire sandbox');
        await cancelable.dispose();

        const overridden = await createSandbox({ wasmUrl: new URL('/relocated/quickjs.wasm', location.href) });
        try { check(await overridden.evaluate('42') === 42, 'WASM asset override'); }
        finally { await overridden.dispose(); }
        const custom = await createSandbox({ workerFactory: () => new Worker('/pkg/dist/browser-worker.js', { type: 'module' }) });
        try { check(await custom.evaluate('42') === 42, 'Worker factory override'); }
        finally { await custom.dispose(); }
        await rejection(createSandbox({ wasmUrl: '/missing-engine.wasm', startupTimeoutMs: 2_000 }));
        await rejection(createSandbox({ workerFactory: () => new Worker('/missing-worker.js', { type: 'module' }), startupTimeoutMs: 2_000 }));
        return { verified, isolated: crossOriginIsolated };
      });
      assert.deepEqual(result, { verified: ['inline', 'worker'], isolated: false });
      console.log(`${name}: ${path} inline/worker, callbacks, handles, timeouts, abort, asset overrides passed`);
    }
    assert.deepEqual(externalRequests, [], 'Browser must not depend on external network requests');
    const loadedWasm = assetResponses.filter(response => response.status === 200);
    assert.ok(loadedWasm.length >= 2, 'WASM assets must actually load');
    assert.ok(loadedWasm.some(response => response.url.includes('/nested/base/')), 'Vite must emit and load WASM beneath the nested deployment base');
    assert.ok(loadedWasm.every(response => response.mime === 'application/wasm'), 'WASM responses must use the correct MIME type');
    await context.close();
    await activeBrowser.close(); activeBrowser = undefined;
  }
} finally {
  clearTimeout(watchdog);
  await activeBrowser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(fixture, { recursive: true, force: true });
}
