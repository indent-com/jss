import { parentPort, workerData } from 'node:worker_threads';
import { runInThisContext } from 'node:vm';

let next = 0;
const pending = new Map();
const host = (method, value) => new Promise((resolve, reject) => {
  const id = ++next;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ kind: 'host', id, method, value });
});
globalThis.hostEcho = value => host('echo', value);
globalThis.hostCopy = value => host('copy', value);
runInThisContext(workerData.source, { filename: 'benchmarks/workloads.js' });
parentPort.on('message', async message => {
  if (message.kind === 'settle') {
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error));
    else callback.resolve(message.value);
    return;
  }
  try {
    const checksum = message.prepare
      ? await benchPrepare(message.name, message.count, message.seed)
      : message.name === 'identity'
      ? await benchIdentity(message.seed)
      : await benchRun(message.name, message.count, message.seed);
    parentPort.postMessage({ kind: 'result', checksum });
  } catch (error) { parentPort.postMessage({ kind: 'result', error: error.stack }); }
});
parentPort.postMessage({ kind: 'ready' });
