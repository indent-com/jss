// Runs dangerous cases in a separate OS process so a broken interrupt cannot hang CI.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createSandbox } from '../dist/node.js';

const [scenario, execution = 'worker'] = process.argv.slice(2);
{
  await using sandbox = await createSandbox({ execution, timeoutMs: 500, memoryLimitBytes: 8 * 1024 * 1024, stackLimitBytes: 128 * 1024 });
  if (scenario === 'loop' || scenario === 'jobs' || scenario === 'proxy' || scenario === 'pending') {
    const source = {
      loop: 'while (true) {}',
      jobs: 'await new Promise(() => { function again() { Promise.resolve().then(again) } again() })',
      proxy: 'new Proxy({}, { ownKeys() { while (true) {} } })',
      pending: 'new Promise(() => {})',
    }[scenario];
    await assert.rejects(sandbox.evaluate(source), error => error.code === 'ERR_TIMEOUT');
    assert.equal(sandbox.disposed, true);
    await assert.rejects(sandbox.evaluate('42'), error => error.code === 'ERR_DISPOSED');
  } else if (scenario === 'background-jobs') {
    assert.equal(await sandbox.evaluate('function again() { Promise.resolve().then(again) } again(); 42'), 42);
    await delay(750);
    assert.equal(sandbox.disposed, true, 'Detached jobs must retain their original deadline');
  } else if (scenario === 'idle-callback') {
    await sandbox.expose('never', () => new Promise(() => {}));
    await assert.rejects(sandbox.evaluate('await never()'), error => error.code === 'ERR_TIMEOUT');
    assert.equal(sandbox.disposed, true);
  } else if (scenario === 'jobs-abort' || scenario === 'calls-yield') {
    const controller = new AbortController();
    const started = performance.now();
    using timer = setTimeout(() => controller.abort(), 30);
    if (scenario === 'jobs-abort') {
      await assert.rejects(sandbox.evaluate('await new Promise(() => { function again() { Promise.resolve().then(again) } again() })', {
        signal: controller.signal, timeoutMs: 5_000,
      }), error => error.code === 'ERR_ABORTED');
      assert.equal(sandbox.disposed, true);
    } else {
      await sandbox.evaluate('globalThis.identity = value => value; undefined');
      while (!controller.signal.aborted) assert.equal(await sandbox.call('identity', [42]), 42);
    }
    assert.ok(performance.now() - started < 1_000, 'Microtask traffic starved a host timer');
  } else if (scenario === 'abort') {
    const controller = new AbortController();
    const pending = sandbox.evaluate('while (true) {}', { signal: controller.signal, timeoutMs: 5_000 });
    const rejected = assert.rejects(pending, error => error.code === 'ERR_ABORTED');
    await delay(50); controller.abort();
    await rejected;
    assert.equal(sandbox.disposed, true);
  } else if (scenario === 'responsive') {
    const pending = sandbox.evaluate('while (true) {}', { timeoutMs: 300 });
    const rejected = assert.rejects(pending, error => error.code === 'ERR_TIMEOUT');
    const started = performance.now();
    await delay(20);
    assert.ok(performance.now() - started < 250, 'Parent event loop was blocked by worker execution');
    await rejected;
  } else if (scenario === 'memory') {
    await assert.rejects(sandbox.evaluate('new Uint8Array(64 * 1024 * 1024)'), error => error instanceof Error);
  } else if (scenario === 'stack') {
    await assert.rejects(sandbox.evaluate('(function recurse() { return recurse() })()'), error => {
      assert.match(error.message, /stack|recurs/i);
      return true;
    });
  } else if (scenario === 'late-callback') {
    let complete;
    await sandbox.expose('later', () => new Promise(resolve => { complete = resolve; }));
    const pending = sandbox.evaluate('await later()');
    const rejected = assert.rejects(pending, error => error.code === 'ERR_DISPOSED');
    while (!complete) await delay(5);
    await sandbox.dispose();
    complete({ late: true });
    await rejected;
    await delay(20);
  } else throw new Error(`Unknown watchdog scenario: ${scenario}`);
}
console.log(JSON.stringify({ scenario, execution, ok: true }));
