import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Worker } from 'node:worker_threads';
import { runInThisContext } from 'node:vm';
import { createSandbox } from '@indent-com/jss';

const echo = async value => value;
const copy = async value => value.slice();

async function timed(prepare, run, identity, name, count, seed) {
  await prepare(name, count, seed);
  const start = performance.now();
  let checksum = 0;
  if (name === 'call') {
    for (let i = 0; i < count; i++) checksum = (checksum + await identity((seed + (i & 31)) >>> 0)) >>> 0;
  } else checksum = await run(name, count, seed);
  return { milliseconds: performance.now() - start, checksum };
}

export function nodeDriver(source) {
  globalThis.hostEcho = echo;
  globalThis.hostCopy = copy;
  runInThisContext(source, { filename: 'benchmarks/workloads.js' });
  return {
    id: 'node', name: 'Node', run: (...args) => timed(benchPrepare, benchRun, benchIdentity, ...args),
    async dispose() {},
    async [Symbol.asyncDispose]() { await this.dispose(); },
  };
}

export async function nodeWorkerDriver(source) {
  await using setup = new AsyncDisposableStack();
  const worker = setup.use(new Worker(new URL('./node-worker.mjs', import.meta.url), { workerData: { source }, execArgv: [] }));
  let pending, failed;
  const ready = new Promise((resolve, reject) => { pending = { resolve, reject }; });
  const fail = error => { failed = error; pending?.reject(error); pending = undefined; };
  worker.on('error', fail);
  worker.on('exit', code => { if (pending) fail(new Error(`Node worker exited: ${code}`)); });
  worker.on('message', message => {
    if (message.kind === 'host') {
      (message.method === 'echo' ? echo : copy)(message.value).then(
        value => worker.postMessage({ kind: 'settle', id: message.id, value }),
        error => worker.postMessage({ kind: 'settle', id: message.id, error: error.message }),
      );
    } else {
      const callback = pending;
      pending = undefined;
      if (message.error) callback.reject(new Error(message.error));
      else callback.resolve(message.checksum);
    }
  });
  await ready;
  const request = (name, count, seed, prepare = false) => new Promise((resolve, reject) => {
    if (failed) { reject(failed); return; }
    pending = { resolve, reject };
    worker.postMessage({ name, count, seed, prepare });
  });
  const resources = setup.move();
  return {
    id: 'node-worker', name: 'Node worker',
    run: (...args) => timed(
      (...values) => request(...values, true), request,
      seed => request('identity', 1, seed), ...args),
    async dispose() { await resources.disposeAsync(); },
    async [Symbol.asyncDispose]() { await this.dispose(); },
  };
}

export async function jssDriver(execution, source) {
  await using setup = new AsyncDisposableStack();
  const sandbox = setup.use(await createSandbox({ execution, timeoutMs: 30_000, memoryLimitBytes: 64 * 1024 * 1024, stackLimitBytes: 512 * 1024 }));
  await sandbox.expose('hostEcho', echo);
  await sandbox.expose('hostCopy', copy);
  await sandbox.evaluate(source + '\nundefined');
  const resources = setup.move();
  return {
    id: `jss-${execution}`, name: `JSS ${execution}`,
    run: (...args) => timed(
      (...values) => sandbox.call('benchPrepare', values),
      (...values) => sandbox.call('benchRun', values),
      seed => sandbox.call('benchIdentity', [seed]), ...args),
    async dispose() { await resources.disposeAsync(); },
    async [Symbol.asyncDispose]() { await this.dispose(); },
  };
}

export async function quickjsDriver(binary, sourcePath) {
  await using setup = new AsyncDisposableStack();
  const process = spawn(binary, [sourcePath], { stdio: ['pipe', 'pipe', 'pipe'] });
  setup.defer(() => { process.stdin.end(); process.kill(); });
  const input = setup.use(createInterface({ input: process.stdout }));
  const lines = input[Symbol.asyncIterator]();
  let stderr = '', failure;
  process.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
  process.on('error', error => { failure = error; input.close(); });
  const next = async () => {
    const line = await lines.next();
    if (line.done) throw failure ?? new Error(`Native QuickJS stopped: ${stderr}`);
    const value = JSON.parse(line.value);
    if (value.error) throw new Error(`Native QuickJS: ${value.error}`);
    return value;
  };
  const metadata = await next();
  if (!metadata.ready) throw new Error('Native QuickJS did not initialize');
  const resources = setup.move();
  return {
    id: 'quickjs', name: 'Native QuickJS', metadata,
    async run(name, count, seed) {
      process.stdin.write(`${name} ${count} ${seed}\n`);
      return next(); // C times execution; pipe I/O is outside that interval.
    },
    async dispose() { await resources.disposeAsync(); },
    async [Symbol.asyncDispose]() { await this.dispose(); },
  };
}
