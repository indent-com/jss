import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSandbox, withSandbox } from '../dist/node.js';

const execute = promisify(execFile);
const code = expected => error => error.code === expected;

for (const execution of ['inline', 'worker']) {
  const scoped = (fn, options = {}) => withSandbox({ execution, timeoutMs: 3_000, ...options }, fn);
  const check = (name, fn) => test(`${execution}: modules ${name}`, { timeout: 20_000 }, fn);

  check('resolve a static graph, re-exports, Unicode paths and import.meta.url', async () => {
    await scoped(async sandbox => {
      await sandbox.defineModule('/app/lib/café.js', 'export const factor = 7; export const url = import.meta.url;');
      await sandbox.defineModule('/app/lib/math.js', 'export { factor, url } from "./café.js"; export default 6;');
      await sandbox.defineModule('/app/main.js', `
        import number, { factor, url } from './lib/../lib/math.js';
        export const result = { answer: number * factor, dependency: url, entry: import.meta.url };
      `);
      assert.deepEqual(await sandbox.evaluateModule('/app/main.js'), {
        result: { answer: 42, dependency: 'jss:/app/lib/caf%C3%A9.js', entry: 'jss:/app/main.js' },
      });
      assert.equal(await sandbox.evaluate('typeof factor'), 'undefined');
    });
  });

  check('keep cached namespace identity and live exports behind handles', async () => {
    await scoped(async sandbox => {
      await sandbox.defineModule('counter', `
        globalThis.executions = (globalThis.executions ?? 0) + 1;
        export let count = 0;
        export function increment() { return ++count; }
      `);
      await using first = await sandbox.evaluateModuleHandle('counter');
      await using second = await sandbox.evaluateModuleHandle('jss:/counter');
      assert.equal(await first.equals(second), true);
      assert.deepEqual(await first.keys(), ['count', 'increment']);
      await using result = await first.invoke('increment');
      assert.equal(await result.dump(), 1);
      await using count = await second.get('count');
      assert.equal(await count.dump(), 1);
      await assert.rejects(first.dump(), code('ERR_CLONE'));
      await assert.rejects(sandbox.evaluateModule('counter'), code('ERR_CLONE'));
      assert.equal(await sandbox.evaluate('executions'), 1);
    });
  });

  check('resolve cycles and wait for asynchronous dependencies', async () => {
    await scoped(async sandbox => {
      let calls = 0;
      await sandbox.expose('twice', async value => { calls++; await delay(5); return value * 2; });
      await sandbox.defineModule('/a.js', `
        import { b } from './b.js';
        export function a(n) { return n ? b(n - 1) + 1 : 0; }
        export const count = a(4);
      `);
      await sandbox.defineModule('/b.js', `
        import { a } from './a.js';
        export function b(n) { return n ? a(n - 1) + 1 : 0; }
      `);
      await sandbox.defineModule('/async.js', 'export const answer = await twice(21);');
      await sandbox.defineModule('/main.js', `
        import { count } from './a.js';
        import { answer } from './async.js';
        export const result = { count, answer };
      `);
      const [first, second] = await Promise.all([
        sandbox.evaluateModule('/main.js'), sandbox.evaluateModule('/main.js'),
      ]);
      assert.deepEqual(first, { result: { count: 4, answer: 42 } });
      assert.deepEqual(second, first);
      assert.equal(calls, 1);
    });
  });

  check('load computed dynamic imports from modules and filename-based scripts', async () => {
    await scoped(async sandbox => {
      await sandbox.defineModule('/app/value.js', 'export const answer = 42;');
      await sandbox.defineModule('/app/main.js', `
        const name = './' + 'value.js';
        export const answer = (await import(name)).answer;
      `);
      assert.deepEqual(await sandbox.evaluateModule('/app/main.js'), { answer: 42 });
      assert.equal(await sandbox.evaluate('(await import("./value.js")).answer', { filename: '/app/script.js' }), 42);
      await assert.rejects(sandbox.evaluate('import("/not-registered.js")'), code('ERR_MODULE_NOT_FOUND'));
      // Sources may be added later; imports only see definitions already present.
      await sandbox.defineModule('/later.js', 'export default 7;');
      assert.equal(await sandbox.evaluate('(await import("/later.js")).default'), 7);
    });
  });

  check('normalize HTTP URLs with no implicit fetch capability', async () => {
    await scoped(async sandbox => {
      await sandbox.defineModule('https://EXAMPLE.invalid:443/lib/../lib/value.js?v=1', 'export const answer = 42;');
      await sandbox.defineModule('https://example.invalid/lib/main.js', `
        import { answer } from './value.js?v=1';
        export const result = { answer, url: import.meta.url, fetch: typeof fetch };
      `);
      assert.deepEqual(await sandbox.evaluateModule('https://example.invalid/lib/main.js'), {
        result: { answer: 42, url: 'https://example.invalid/lib/main.js', fetch: 'undefined' },
      });
      await assert.rejects(sandbox.evaluateModule('https://example.invalid/absent.js'), error => {
        assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
        assert.match(error.message, /https:\/\/example\.invalid\/absent\.js/);
        return true;
      });
    });
  });

  check('reject duplicate names, invalid names and unsupported import attributes', async () => {
    await scoped(async sandbox => {
      await sandbox.defineModule('/value.js', 'export const answer = 42;');
      await assert.rejects(sandbox.defineModule('jss:/dir/../value.js', 'export const answer = 0;'), code('ERR_MODULE_DEFINED'));
      for (const name of ['', 'x\0y', 'x\\y', '\ud800', 'file:///etc/passwd']) {
        await assert.rejects(sandbox.defineModule(name, 'export default 0;'), code('ERR_MODULE_NAME'));
      }
      await sandbox.defineModule('/attributes.js', 'import value from "./value.js" with { type: "json" };');
      await assert.rejects(sandbox.evaluateModule('/attributes.js'), code('ERR_MODULE_ATTRIBUTES'));
      await assert.rejects(sandbox.evaluate('import("/value.js", { with: { type: "json" } })'), code('ERR_MODULE_ATTRIBUTES'));
      assert.deepEqual(await sandbox.evaluateModule('/value.js'), { answer: 42 });
    });
  });

  check('preserve syntax errors, rejected top-level await and failed-module caching', async () => {
    await scoped(async sandbox => {
      await sandbox.defineModule('/syntax.js', 'export const = 1');
      await assert.rejects(sandbox.evaluateModule('/syntax.js'), error => error.name === 'SyntaxError');
      await sandbox.defineModule('/failure.js', `
        globalThis.failedRuns = (globalThis.failedRuns ?? 0) + 1;
        await Promise.resolve();
        throw new Error('module failure');
      `);
      for (let i = 0; i < 2; i++) {
        await assert.rejects(sandbox.evaluateModule('/failure.js'), error => {
          assert.equal(error.code, 'ERR_GUEST');
          assert.equal(error.message, 'module failure');
          assert.match(error.guestStack, /jss:\/failure\.js/);
          return true;
        });
      }
      assert.equal(await sandbox.evaluate('failedRuns'), 1);
      assert.equal(await sandbox.evaluate('42'), 42);
    });
  });

  check('use captured promise and bridge intrinsics during module loading', async () => {
    await scoped(async sandbox => {
      await sandbox.defineModule('/main.js', 'export const result = await 42;');
      await sandbox.evaluate(`
        Promise.prototype.then = function () { throw Error('replaced then'); };
        globalThis.URL = function () { throw Error('guest URL'); };
        Object.prototype.handle = 42;
        JSON.stringify = () => { throw Error('guest stringify'); };
        undefined
      `);
      assert.deepEqual(await sandbox.evaluateModule('/main.js'), { result: 42 });
    });
  });

  check('charge registered source to the guest heap and reject excess aggregate source', async () => {
    await scoped(async sandbox => {
      const source = ' '.repeat(8 * 1024 * 1024);
      await sandbox.defineModule('/one.js', source);
      await sandbox.defineModule('/two.js', source);
      await assert.rejects(sandbox.defineModule('/three.js', ' '), code('ERR_RESOURCE_LIMIT'));
    }, { timeoutMs: 10_000 });
    {
      await using sandbox = await createSandbox({ execution, memoryLimitBytes: 2 * 1024 * 1024, timeoutMs: 3_000 });
      const source = ' '.repeat(128 * 1024);
      let failed = false;
      for (let i = 0; i < 20; i++) {
        try { await sandbox.defineModule(`/memory-${i}.js`, source); }
        catch (error) { assert.ok(error instanceof Error); failed = true; break; }
      }
      assert.equal(failed, true, 'registered module source must count toward the guest heap limit');
    }
    await scoped(async sandbox => {
      await assert.rejects(sandbox.evaluate(`
        globalThis.retainedBuffers = [];
        for (let i = 0; i < 20; i++) retainedBuffers.push(new ArrayBuffer(128 * 1024));
        undefined
      `), error => {
        assert.match(error.message, /out of memory|allocation|serialize/i);
        return true;
      });
    }, { memoryLimitBytes: 2 * 1024 * 1024 });
  });

  check('enforce evaluation deadlines for loops and pending top-level await', async () => {
    const entry = new URL('../dist/node.js', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import { createSandbox } from ${JSON.stringify(entry)};
      for (const source of ['while (true) {}', 'await new Promise(() => {});']) {
        await using sandbox = await createSandbox({ execution: ${JSON.stringify(execution)}, timeoutMs: 2_000 });
        await sandbox.defineModule('/deadline.js', source);
        await assert.rejects(sandbox.evaluateModule('/deadline.js', { timeoutMs: 100 }), error => error.code === 'ERR_TIMEOUT');
        assert.equal(sandbox.disposed, true);
      }
      console.log('ok');
    `;
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    assert.equal(stdout.trim(), 'ok');
  });
}
