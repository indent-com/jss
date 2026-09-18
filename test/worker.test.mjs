import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createSandbox } from '../dist/node.js';

class DelayedWorker extends EventEmitter {
  terminations = 0;
  postMessage() {}
  async terminate() { this.terminations++; }
}

test('startup timeout terminates a custom worker and ignores late readiness', { timeout: 5_000 }, async () => {
  const worker = new DelayedWorker();
  await assert.rejects(createSandbox({ workerFactory: () => worker, startupTimeoutMs: 25 }), error => error.code === 'ERR_INIT_TIMEOUT');
  assert.ok(worker.terminations >= 1);
  worker.emit('message', { kind: 'ready' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(worker.terminations >= 1);
});

test('cancellation during worker startup terminates the owned worker', { timeout: 5_000 }, async () => {
  const worker = new DelayedWorker();
  const controller = new AbortController();
  const startup = createSandbox({ workerFactory: () => worker, signal: controller.signal });
  controller.abort();
  await assert.rejects(startup, error => error.code === 'ERR_ABORTED');
  assert.ok(worker.terminations >= 1);
});

test('unexpected worker exit rejects outstanding requests and retires its sandbox', { timeout: 10_000 }, async () => {
  const worker = new Worker(new URL('../dist/node-worker.js', import.meta.url), { execArgv: [] });
  let sandbox;
  try {
    sandbox = await createSandbox({ workerFactory: () => worker });
    const pending = sandbox.evaluate('new Promise(() => {})', { timeoutMs: 5_000 });
    const rejected = assert.rejects(pending, error => error.code === 'ERR_WORKER');
    await worker.terminate();
    await rejected;
    assert.equal(sandbox.disposed, true);
    await assert.rejects(sandbox.evaluate('42'), error => error.code === 'ERR_DISPOSED');
  } finally { await sandbox?.dispose(); await worker.terminate(); }
});
