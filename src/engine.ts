import type { Command, EngineHooks, EngineOptions, Input, WireError, WireValue } from './protocol.js';
import { failure, fromWire, toWire } from './errors.js';

interface Module {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _jss_create(memory: number, stack: number): number;
  _jss_command(pointer: number, length: number, deadline: number, table: number, count: number): number;
  _jss_jobs(count: number, deadline: number): number;
  _jss_events(checkpoint: number): number;
  _jss_output_length(): number;
  _jss_output_count(): number;
  _jss_output_data(index: number): number;
  _jss_output_size(index: number): number;
  _jss_release_output(): void;
  _jss_dispose(): void;
}
interface Request {
  command: Command;
  timeoutMs: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
interface Pending {
  watch: number;
  deadline: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
type Event =
  | {kind: 'call'; callId: number; functionId: number; thisId: number; args: number[]; copied?: WireValue[]}
  | {kind: 'unhandled'; error: WireError};

const clock = () => performance.now();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_BRIDGE_BYTES = 64 * 1024 * 1024;
const MAX_ATTACHMENTS = 100_000;
const SLICE_MS = 4;
const MAX_SLICE_TURNS = 128;

/** Owns one private WASM instance. Only copied IDs leave this driver. */
export class Engine {
  private module: Module;
  private options: EngineOptions;
  private hooks: EngineHooks;
  private queue: Request[] = [];
  private controls: Command[] = [];
  private pending = new Map<number, Pending>();
  private callbacks = new Map<number, number>();
  private scheduled = false;
  private task?: ReturnType<typeof setTimeout>;
  private sliceDeadline = 0;
  private sliceTurns = 0;
  private expiry?: ReturnType<typeof setTimeout>;
  private busy = false;
  private closed = false;
  private jobs = false;
  private backgroundDeadline?: number;

  private constructor(module: Module, options: EngineOptions, hooks: EngineHooks) {
    this.module = module;
    this.options = options;
    this.hooks = hooks;
  }

  static async create(options: EngineOptions, hooks: EngineHooks): Promise<Engine> {
    // The generated ESM loader has no Node imports. Node adapters supply bytes.
    const {default: factory} = await import('./engine/quickjs.js');
    const module = await factory({
      wasmBinary: options.wasmBinary,
      locateFile: (name: string) => options.wasmUrl ??
        new URL('./engine/' + name, import.meta.url).href,
      print: () => {},
      printErr: () => {},
      onAbort: (reason: unknown) => { throw failure('ERR_FATAL', String(reason), 'EngineError'); },
    }) as Module;
    if (!module._jss_create(options.memoryLimitBytes, options.stackLimitBytes)) {
      module._jss_dispose();
      throw failure('ERR_INITIALIZATION', 'Could not initialize the QuickJS runtime within its memory limit', 'InitializationError');
    }
    return new Engine(module, options, hooks);
  }

  execute(command: Command, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(failure('ERR_DISPOSED', 'Sandbox is disposed', 'DisposedError'));
    return new Promise((resolve, reject) => {
      this.queue.push({command, timeoutMs, resolve, reject});
      this.schedule();
    });
  }

  settle(callId: number, value: Input, error?: WireError): void {
    if (this.closed || !this.callbacks.has(callId)) return;
    this.callbacks.delete(callId);
    this.controls.push({op: 'settle', args: [callId, value, error ?? null]});
    this.schedule();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.task !== undefined) clearTimeout(this.task);
    this.scheduled = false;
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    const error = failure('ERR_DISPOSED', 'Sandbox is disposed', 'DisposedError');
    for (const request of this.queue) request.reject(error);
    for (const request of this.pending.values()) request.reject(error);
    this.queue.length = 0;
    this.controls.length = 0;
    this.pending.clear();
    this.callbacks.clear();
    try { this.module._jss_dispose(); } catch {
      // A trapped instance may no longer admit C cleanup. Dropping it releases
      // its isolated memory; all JS-side requests are already settled.
    }
    this.module = undefined as unknown as Module;
  }

  private schedule(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    if (this.task === undefined) {
      this.sliceDeadline = clock() + SLICE_MS;
      this.sliceTurns = 0;
      // Reset only at a real host task. Empty guest queues are insufficient:
      // a host promise continuation can immediately submit another command.
      this.task = setTimeout(() => {
        this.task = undefined;
        if (this.scheduled) { this.scheduled = false; this.schedule(); }
      }, 0);
    }
    if (clock() < this.sliceDeadline && this.sliceTurns < MAX_SLICE_TURNS) {
      queueMicrotask(() => {
        if (this.closed || !this.scheduled) return;
        this.scheduled = false;
        this.sliceTurns++;
        this.turn();
      });
    }
  }

  private until(extra = Infinity): number {
    let until = extra;
    for (const request of this.pending.values()) until = Math.min(until, request.deadline);
    for (const time of this.callbacks.values()) until = Math.min(until, time);
    if (this.backgroundDeadline !== undefined) until = Math.min(until, this.backgroundDeadline);
    return Number.isFinite(until) ? until : clock() + this.options.timeoutMs;
  }

  private read(pointer: number): any {
    try {
      const length = this.module._jss_output_length(), count = this.module._jss_output_count();
      let total = length + count * 8;
      const heap = this.module.HEAPU8;
      if (total > MAX_BRIDGE_BYTES || count > MAX_ATTACHMENTS || pointer > heap.length - length)
        throw failure('ERR_FATAL', 'Invalid bridge response', 'EngineError');
      const attachments: Uint8Array[] = [];
      // Getters do not allocate or execute guest code. Copy before releasing
      // native references; no returned or transferred buffer aliases WASM.
      for (let index = 0; index < count; index++) {
        const start = this.module._jss_output_data(index), size = this.module._jss_output_size(index);
        if (size > 16 * 1024 * 1024 || (total += size) > MAX_BRIDGE_BYTES || start > heap.length - size)
          throw failure('ERR_FATAL', 'Invalid binary response', 'EngineError');
        attachments.push(heap.slice(start, start + size));
      }
      const text = decoder.decode(heap.subarray(pointer, pointer + length));
      const result = count === 0 ? JSON.parse(text) : JSON.parse(text, (_key, value) => {
        if (value !== null && typeof value === 'object' && Object.hasOwn(value, '$jssBytes')) {
          const index = value.$jssBytes;
          if (Object.keys(value).length !== 1 || !Number.isInteger(index) || index < 0 || index >= count)
            throw failure('ERR_FATAL', 'Invalid binary attachment index', 'EngineError');
          return attachments[index];
        }
        return value;
      });
      if (!result.ok) throw fromWire(result.error);
      return result.value;
    } finally {
      this.module._jss_release_output();
    }
  }

  private entry(command: Command, until: number): any {
    const attachments: Uint8Array[] = [];
    let binarySize = 0;
    const oversized = () => failure('ERR_RESOURCE_LIMIT', 'Bridge message exceeds its size limit', 'ResourceLimitError');
    const bytes = encoder.encode(JSON.stringify(command, (_key, value) => {
      if (value instanceof Uint8Array) {
        if (attachments.length === MAX_ATTACHMENTS || (binarySize += value.byteLength + 8) > MAX_BRIDGE_BYTES) throw oversized();
        const index = attachments.length;
        attachments.push(value);
        return { $jssBytes: index };
      }
      return value;
    }));
    const aligned = Math.ceil((bytes.length + 1) / 4) * 4;
    if (aligned + binarySize > MAX_BRIDGE_BYTES) throw oversized();
    const pointer = this.module._malloc(aligned + binarySize);
    if (!pointer) throw failure('ERR_MEMORY', 'Could not allocate bridge input', 'MemoryLimitError');
    try {
      // malloc can grow memory; obtain the current view after allocating.
      const heap = this.module.HEAPU8, table = pointer + aligned;
      heap.set(bytes, pointer);
      heap[pointer + bytes.length] = 0;
      const descriptors = new DataView(heap.buffer, table, attachments.length * 8);
      let data = table + attachments.length * 8;
      for (let index = 0; index < attachments.length; index++) {
        const attachment = attachments[index];
        descriptors.setUint32(index * 8, data, true);
        descriptors.setUint32(index * 8 + 4, attachment.byteLength, true);
        heap.set(attachment, data);
        data += attachment.byteLength;
      }
      return this.read(this.module._jss_command(pointer, bytes.length, until, table, attachments.length));
    } finally {
      this.module._free(pointer);
    }
  }

  private fatal(error: unknown): void {
    if (this.closed) return;
    // Preserve the actual failure for requests before dispose rejects leftovers.
    for (const request of this.queue) request.reject(error);
    for (const request of this.pending.values()) request.reject(error);
    this.queue.length = 0;
    this.pending.clear();
    const wire = toWire(error);
    this.dispose();
    this.hooks.onFatal(wire);
  }

  private isFatal(error: unknown): boolean {
    const code = (error as {code?: string})?.code;
    return code === 'ERR_TIMEOUT' || code === 'ERR_MEMORY' || code === 'ERR_FATAL';
  }

  private turn(): void {
    if (this.closed || this.busy) return;
    this.busy = true;
    const events: Event[] = [];
    try {
      if (this.until() <= clock()) {
        throw failure('ERR_TIMEOUT', 'An operation or host callback exceeded its deadline', 'TimeoutError');
      }
      // Settlements are a control path and cannot wait behind a guest promise.
      while (this.controls.length && !this.closed) {
        this.entry(this.controls.shift()!, this.until());
      }
      for (let count = 0; count < 32 && this.queue.length && !this.closed; count++) {
        const request = this.queue.shift()!;
        const deadline = clock() + request.timeoutMs;
        try {
          const result = this.entry(request.command, this.until(deadline));
          if (result && typeof result === 'object' && typeof result.pending === 'number') {
            this.pending.set(result.pending, {watch: result.pending, deadline, resolve: request.resolve, reject: request.reject});
          } else request.resolve(result);
        } catch (error) {
          request.reject(error);
          if (this.isFatal(error)) throw error;
        }
        if (clock() >= this.sliceDeadline) break;
      }
      if (this.closed) return;
      // Amortize job pumping within a bounded time slice. Only an operation's
      // actual deadline reaches C: a fairness yield must not kill the realm.
      for (let batches = 0; ; batches++) {
        this.jobs = Boolean(this.read(this.module._jss_jobs(256, this.until())));
        if (!this.jobs || batches === 15 || clock() >= this.sliceDeadline) break;
      }
      for (const request of [...this.pending.values()]) {
        try {
          const state = this.entry({op: 'poll', args: [request.watch]}, this.until());
          if (!state.pending) {
            this.pending.delete(request.watch);
            request.resolve(state.result);
          }
        } catch (error) {
          this.pending.delete(request.watch);
          request.reject(error);
          if (this.isFatal(error)) throw error;
        }
      }
      // Unwrapping script completion can start thenable assimilation and enqueue
      // new jobs even if the preceding batch drained the original queue.
      this.jobs = Boolean(this.read(this.module._jss_jobs(0, this.until())));
      events.push(...this.read(this.module._jss_events(this.jobs ? 0 : 1)));
      for (const event of events) {
        if (event.kind === 'call') this.callbacks.set(event.callId, clock() + this.options.timeoutMs);
      }
      if (this.jobs) this.backgroundDeadline ??= clock() + this.options.timeoutMs;
      else this.backgroundDeadline = undefined;
      this.armExpiry();
    } catch (error) {
      this.fatal(error);
    } finally {
      this.busy = false;
    }
    // No application callback runs while the WASM stack is active.
    for (const event of events) {
      if (this.closed) break;
      try {
        if (event.kind === 'call') this.hooks.hostCall(event.callId, event.functionId, event.thisId, event.args, event.copied);
        else this.hooks.onUnhandled(event.error);
      } catch (error) {
        if (event.kind === 'call') this.settle(event.callId, {value: ['undefined']}, toWire(error));
      }
    }
    if (this.jobs || this.queue.length || this.controls.length) this.schedule();
  }

  private armExpiry(): void {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    this.expiry = undefined;
    if (!this.pending.size && !this.callbacks.size && this.backgroundDeadline === undefined) return;
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      if (!this.closed) {
        if (this.until() <= clock()) {
          this.fatal(failure('ERR_TIMEOUT', 'An operation or host callback exceeded its deadline', 'TimeoutError'));
        } else this.armExpiry();
      }
    }, Math.max(1, Math.ceil(this.until() - clock())));
  }
}
