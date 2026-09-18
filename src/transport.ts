import type { Command, EngineHooks, EngineOptions, Input, WireError, ToWorker, FromWorker } from './protocol.js';
import { failure, fromWire, toWire } from './errors.js';

export interface WorkerLike {
  postMessage(message: unknown): void;
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  terminate(): unknown;
  addEventListener?: (type: string, listener: any) => void;
  on?: (type: string, listener: (...args: any[]) => void) => unknown;
}

// The protocol owns every byte view: encode() snapshots caller data and the
// engine copies guest attachments out of WASM. Only these copies are detached.
function transferList(message: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  function visit(value: any): void {
    if (value instanceof Uint8Array) { buffers.add(value.buffer as ArrayBuffer); return; }
    if (value !== null && typeof value === 'object') for (const item of Object.values(value)) visit(item);
  }
  visit(message);
  return [...buffers];
}
export interface Adapter {
  spawn(): WorkerLike;
  loadWasm(url?: string): Promise<Uint8Array>;
  normalizeUrl(url: string | URL): string;
}
export interface Transport {
  execute(command: Command, timeoutMs: number): Promise<any>;
  settle(callId: number, value: Input, error?: WireError): void;
  dispose(): Promise<void>;
}

export async function connectInline(options: EngineOptions, hooks: EngineHooks, adapter: Adapter): Promise<Transport> {
  const [{ Engine }, wasmBinary] = await Promise.all([import('./engine.js'), adapter.loadWasm(options.wasmUrl)]);
  const engine = await Engine.create({ ...options, wasmBinary }, hooks);
  return {
    execute: (command, timeout) => engine.execute(command, timeout),
    settle: (id, value, error) => engine.settle(id, value, error),
    dispose: async () => { engine.dispose(); },
  };
}

export function connectWorker(options: EngineOptions, hooks: EngineHooks, worker: WorkerLike): Promise<Transport> {
  return new Promise((resolve, reject) => {
    let nextId = 1, closed = false, ready = false;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
    const fail = (wire: WireError) => {
      if (closed) return;
      closed = true;
      const error = fromWire(wire);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      reject(error);
      try { Promise.resolve(worker.terminate()).catch(() => {}); } catch {}
      if (ready) hooks.onFatal(wire);
    };
    const transport: Transport = {
      execute(command, timeoutMs) {
        if (closed) return Promise.reject(failure('ERR_DISPOSED', 'Sandbox is disposed', 'DisposedError'));
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try {
            const message = { kind: 'execute', id, command, timeoutMs } satisfies ToWorker;
            worker.postMessage(message, transferList(message));
          }
          catch (error) { pending.delete(id); reject(error); }
        });
      },
      settle(callId, value, error) {
        if (!closed) {
          try {
            const message = { kind: 'settle', callId, value, error } satisfies ToWorker;
            worker.postMessage(message, transferList(message));
          }
          catch (error) { fail(toWire(error)); }
        }
      },
      async dispose() {
        if (closed) return;
        closed = true;
        const error = failure('ERR_DISPOSED', 'Sandbox is disposed', 'DisposedError');
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        // The entire isolated instance is discarded. This cannot wait on a guest job.
        await worker.terminate();
      },
    };
    const receive = (message: FromWorker) => {
      if (closed) return;
      switch (message.kind) {
        case 'ready': ready = true; resolve(transport); break;
        case 'result': case 'error': {
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.kind === 'result') request.resolve(message.value);
          else request.reject(fromWire(message.error));
          break;
        }
        case 'hostCall': hooks.hostCall(message.callId, message.functionId, message.thisId, message.args, message.copied); break;
        case 'unhandled': hooks.onUnhandled(message.error); break;
        case 'fatal': fail(message.error); break;
      }
    };
    if (worker.on) {
      worker.on('message', receive);
      worker.on('error', (error) => fail(toWire(error)));
      worker.on('exit', (code) => { if (!closed) fail({ name: 'WorkerError', code: 'ERR_WORKER', message: `Worker exited unexpectedly (${code})` }); });
    } else if (worker.addEventListener) {
      worker.addEventListener('message', (event: MessageEvent<FromWorker>) => receive(event.data));
      worker.addEventListener('error', (event: ErrorEvent) => fail({ name: 'WorkerError', code: 'ERR_WORKER', message: event.message || 'Worker failed to start' }));
      worker.addEventListener('messageerror', () => fail({ name: 'WorkerError', code: 'ERR_WORKER', message: 'Worker message could not be decoded' }));
    } else {
      fail({ name: 'TypeError', code: 'ERR_OPTIONS', message: 'workerFactory must return a Worker' });
      return;
    }
    try { worker.postMessage({ kind: 'init', options } satisfies ToWorker); }
    catch (error) { fail(toWire(error)); }
  });
}

export function serveWorker(
  send: (message: FromWorker, transfer: ArrayBuffer[]) => void,
  listen: (receive: (message: ToWorker) => void) => void,
  loadWasm: Adapter['loadWasm'],
): void {
  let engine: import('./engine.js').Engine | undefined;
  let starting = false;
  const safeSend = (message: FromWorker) => { try { send(message, transferList(message)); } catch {} };
  listen((message) => {
    if (message.kind === 'init') {
      if (starting) return;
      starting = true;
      void (async () => {
        const [{ Engine }, wasmBinary] = await Promise.all([import('./engine.js'), loadWasm(message.options.wasmUrl)]);
        engine = await Engine.create({ ...message.options, wasmBinary }, {
          hostCall: (callId, functionId, thisId, args, copied) => safeSend({ kind: 'hostCall', callId, functionId, thisId, args, copied }),
          onUnhandled: (error) => safeSend({ kind: 'unhandled', error }),
          onFatal: (error) => safeSend({ kind: 'fatal', error }),
        });
        safeSend({ kind: 'ready' });
      })().catch((error) => safeSend({ kind: 'fatal', error: toWire(error) }));
    } else if (message.kind === 'execute') {
      if (!engine) { safeSend({ kind: 'error', id: message.id, error: { name: 'Error', code: 'ERR_INIT', message: 'Engine is not ready' } }); return; }
      void engine.execute(message.command, message.timeoutMs).then(
        (value) => safeSend({ kind: 'result', id: message.id, value }),
        (error) => safeSend({ kind: 'error', id: message.id, error: toWire(error) }),
      );
    } else if (message.kind === 'settle') {
      try { engine?.settle(message.callId, message.value, message.error); }
      catch (error) { safeSend({ kind: 'fatal', error: toWire(error) }); }
    } else if (message.kind === 'dispose') {
      engine?.dispose(); engine = undefined; safeSend({ kind: 'disposed' });
    }
  });
}
