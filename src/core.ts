import type { Command, EngineHooks, EngineOptions, Input, WireValue } from './protocol.js';
import { encode, decode } from './codec.js';
import { SandboxError, failure, fromWire, toWire } from './errors.js';
import { connectInline, connectWorker, type Adapter, type Transport, type WorkerLike } from './transport.js';
export { SandboxError } from './errors.js';

export interface ExecutionOptions {
  filename?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
/** Modules use their registered canonical name as the filename. */
export type ModuleOptions = Pick<ExecutionOptions, 'timeoutMs' | 'signal'>;
export interface SandboxOptions {
  execution?: 'worker' | 'inline';
  memoryLimitBytes?: number;
  stackLimitBytes?: number;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  maxPendingOperations?: number;
  globals?: Record<string, unknown>;
  wasmUrl?: string | URL;
  workerFactory?: () => WorkerLike;
  onUnhandledRejection?: (error: SandboxError) => void;
  signal?: AbortSignal;
}
export type HostFunction = (...args: any[]) => unknown;
export type HandleFunction = (receiver: Handle, args: Handle[]) => unknown;
export type PropertyKey = string | number | Handle;
export type GuestType = 'undefined' | 'null' | 'boolean' | 'number' | 'string' | 'bigint' | 'symbol' | 'function' | 'object';
const owner = Symbol('jss.handle');
const absent: Input = { value: ['undefined'] };

function positive(value: number | undefined, fallback: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0 || n > maximum) throw failure('ERR_OPTIONS', `${name} must be an integer between 1 and ${maximum}`, 'RangeError');
  return n;
}
function abortError(): SandboxError { return failure('ERR_ABORTED', 'Execution was aborted; its sandbox has been disposed', 'AbortError'); }
function timeoutError(): SandboxError { return failure('ERR_TIMEOUT', 'Execution exceeded its deadline; its sandbox has been disposed', 'TimeoutError'); }

/** A persistent QuickJS realm. All operations are asynchronous. */
export class Sandbox {
  #transport?: Transport;
  #closed = false;
  #closing?: Promise<void>;
  #pending = new Set<(error: unknown) => void>();
  #functions = new Map<number, { fn: HostFunction | HandleFunction; handles: boolean }>();
  #nextFunction = 1;
  #timeout: number;
  #capacity: number;
  #unhandled?: (error: SandboxError) => void;

  private constructor(options: SandboxOptions) {
    this.#timeout = positive(options.timeoutMs, 1000, 'timeoutMs', 2_147_483_647);
    this.#capacity = positive(options.maxPendingOperations, 128, 'maxPendingOperations', 100_000);
    this.#unhandled = options.onUnhandledRejection;
  }

  /** @internal */
  static async _create(options: SandboxOptions, adapter: Adapter): Promise<Sandbox> {
    if (options === null || typeof options !== 'object') throw failure('ERR_OPTIONS', 'Options must be an object', 'TypeError');
    const sandbox = new Sandbox(options);
    const execution = options.execution ?? 'worker';
    if (execution !== 'worker' && execution !== 'inline') throw failure('ERR_OPTIONS', 'execution must be worker or inline', 'TypeError');
    const engineOptions: EngineOptions = {
      memoryLimitBytes: positive(options.memoryLimitBytes, 64 * 1024 * 1024, 'memoryLimitBytes', 192 * 1024 * 1024),
      stackLimitBytes: positive(options.stackLimitBytes, 512 * 1024, 'stackLimitBytes', 1024 * 1024),
      timeoutMs: sandbox.#timeout,
      wasmUrl: options.wasmUrl === undefined ? undefined : adapter.normalizeUrl(options.wasmUrl),
    };
    const startupTimeout = positive(options.startupTimeoutMs, 10_000, 'startupTimeoutMs', 2_147_483_647);
    if (options.signal?.aborted) throw abortError();
    const hooks: EngineHooks = {
      hostCall: (...args) => { void sandbox.#hostCall(...args); },
      onUnhandled: (error) => {
        if (sandbox.#closed) return;
        try { sandbox.#unhandled?.(fromWire(error)); }
        catch (error) { console.error('[jss] onUnhandledRejection failed:', error); }
      },
      onFatal: (error) => { void sandbox.#retire(fromWire(error)); },
    };
    let worker: WorkerLike | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStartup: (error: unknown) => void = () => {};
    const aborted = () => rejectStartup(abortError());
    try {
      const creation = execution === 'worker'
        ? connectWorker(engineOptions, hooks, worker = (options.workerFactory ? options.workerFactory() : adapter.spawn()))
        : connectInline(engineOptions, hooks, adapter);
      // A late successful initialization after timeout must not leak its runtime.
      void creation.then((transport) => { if (sandbox.#closed) void transport.dispose(); }, () => {});
      sandbox.#transport = await Promise.race([creation, new Promise<never>((_, reject) => {
        rejectStartup = reject;
        timer = setTimeout(() => reject(failure('ERR_INIT_TIMEOUT', 'Sandbox initialization timed out', 'TimeoutError')), startupTimeout);
        options.signal?.addEventListener('abort', aborted, { once: true });
        if (options.signal?.aborted) aborted();
      })]);
      if (options.globals !== undefined) {
        for (const [key, value] of Object.entries(options.globals)) await sandbox.set(key, value);
      }
      return sandbox;
    } catch (error) {
      await sandbox.#retire(error);
      if (worker) await worker.terminate();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', aborted);
    }
  }

  get disposed(): boolean { return this.#closed; }
  async #retire(error: unknown): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const reject of this.#pending) reject(error);
    this.#pending.clear();
    this.#functions.clear();
    this.#closing = this.#transport?.dispose() ?? Promise.resolve();
    return this.#closing;
  }

  /** @internal */
  async _request(op: string, args: any[] = [], options: ExecutionOptions = {}, cleanup = false): Promise<any> {
    if (this.#closed || !this.#transport) throw failure('ERR_DISPOSED', 'Sandbox is disposed', 'DisposedError');
    const timeout = positive(options.timeoutMs, this.#timeout, 'timeoutMs', 2_147_483_647);
    if (options.signal?.aborted) throw abortError();
    if (!cleanup && this.#pending.size >= this.#capacity) throw failure('ERR_QUEUE_FULL', 'Too many outstanding operations', 'QueueFullError');
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value: any, error = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', aborted);
        this.#pending.delete(failed);
        if (error) reject(value); else resolve(value);
      };
      const failed = (error: unknown) => finish(error, true);
      const aborted = () => { void this.#retire(abortError()).catch(() => {}); };
      const timer = setTimeout(() => { void this.#retire(timeoutError()).catch(() => {}); }, timeout);
      this.#pending.add(failed);
      options.signal?.addEventListener('abort', aborted, { once: true });
      if (options.signal?.aborted) { aborted(); return; }
      void this.#transport!.execute({ op, args } satisfies Command, timeout).then((value) => {
        if (performance.now() - started > timeout) { void this.#retire(timeoutError()).catch(() => {}); return; }
        finish(value);
      }, (error) => {
        const normalized = error instanceof Error ? error : fromWire(toWire(error));
        const code = (normalized as any).code;
        if (code === 'ERR_TIMEOUT' || code === 'ERR_MEMORY' || code === 'ERR_FATAL') {
          void this.#retire(normalized).catch(() => {});
        } else finish(normalized, true);
      });
    });
  }

  /** @internal */
  _input(value: unknown): Input {
    if (value instanceof Handle) return value._input(this);
    return { value: encode(value) };
  }
  /** @internal */
  _wrap(id: number): Handle { return Handle._from(this, id); }

  #source(source: string, options: ExecutionOptions): void {
    if (typeof source !== 'string') throw failure('ERR_SOURCE', 'Source must be a string', 'TypeError');
    if (source.length * 2 > 16 * 1024 * 1024) throw failure('ERR_LIMIT', 'Source exceeds 16 MiB', 'RangeError');
    if (options.filename !== undefined && (typeof options.filename !== 'string' || options.filename.length > 4096)) throw failure('ERR_OPTIONS', 'filename must be a string of at most 4096 characters', 'TypeError');
  }
  async evaluateHandle(source: string, options: ExecutionOptions = {}): Promise<Handle> {
    this.#source(source, options);
    return this._wrap(await this._request('evaluate', [source, options.filename ?? '<eval>'], options));
  }
  async evaluate<T = unknown>(source: string, options: ExecutionOptions = {}): Promise<T> {
    this.#source(source, options);
    return decode(await this._request('evaluateCopy', [source, options.filename ?? '<eval>'], options) as WireValue) as T;
  }
  /** Register immutable JavaScript source without executing it or granting I/O. */
  async defineModule(name: string, source: string, options: ModuleOptions = {}): Promise<void> {
    this.#moduleName(name);
    if (typeof source !== 'string') throw failure('ERR_SOURCE', 'Module source must be a string', 'TypeError');
    if (source.length * 2 > 16 * 1024 * 1024) throw failure('ERR_LIMIT', 'Module source exceeds 16 MiB', 'RangeError');
    await this._request('defineModule', [name, source], options);
  }
  /** Evaluate a registered module and own its namespace, after top-level await. */
  async evaluateModuleHandle(name: string, options: ModuleOptions = {}): Promise<Handle> {
    this.#moduleName(name);
    return this._wrap(await this._request('evaluateModule', [name], options));
  }
  /** Copy a module namespace; exported functions and other opaque values need a handle. */
  async evaluateModule<T = Record<string, unknown>>(name: string, options: ModuleOptions = {}): Promise<T> {
    this.#moduleName(name);
    return decode(await this._request('evaluateModuleCopy', [name], options) as WireValue) as T;
  }
  #moduleName(name: string): void {
    if (typeof name !== 'string' || name.length === 0 || name.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(name)) {
      throw failure('ERR_MODULE_NAME', 'Module name must be a nonempty string of at most 4096 characters without control characters or backslashes', 'ModuleResolutionError');
    }
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = name.charCodeAt(++i);
        if (next >= 0xdc00 && next <= 0xdfff) continue;
      } else if (code < 0xdc00 || code > 0xdfff) continue;
      throw failure('ERR_MODULE_NAME', 'Module names cannot contain unpaired UTF-16 surrogates', 'ModuleResolutionError');
    }
  }
  async handle(value: unknown): Promise<Handle> { return this._wrap(await this._request('make', [this._input(value)])); }
  async global(options: ExecutionOptions = {}): Promise<Handle> { return this._wrap(await this._request('global', [], options)); }
  async set(name: string, value: unknown): Promise<void> {
    this.#name(name);
    const global = await this.global();
    try { await global.set(name, value); } finally { await global.dispose(); }
  }
  async get<T = unknown>(name: string): Promise<T> {
    this.#name(name);
    const global = await this.global();
    let result: Handle | undefined;
    try { result = await global.get(name); return await result.dump<T>(); }
    finally { await result?.dispose(); await global.dispose(); }
  }
  async call<T = unknown>(name: string, args: readonly unknown[] = [], options: ExecutionOptions = {}): Promise<T> {
    this.#name(name);
    if (!Array.isArray(args)) throw failure('ERR_OPTIONS', 'Arguments must be an array', 'TypeError');
    const started = performance.now();
    const budget = positive(options.timeoutMs, this.#timeout, 'timeoutMs', 2_147_483_647);
    const inputs = args.map((arg) => this._input(arg));
    const remaining = Math.floor(budget - (performance.now() - started));
    if (remaining <= 0) { void this.#retire(timeoutError()).catch(() => {}); throw timeoutError(); }
    // Dispatch before yielding: argument handles may be disposed immediately by
    // the caller. The engine retains operands, observes promises and copies the
    // result under this operation's single deadline.
    return decode(await this._request('callGlobalCopy', [name, inputs], { ...options, timeoutMs: remaining }) as WireValue) as T;
  }
  #name(name: string): void {
    if (typeof name !== 'string') throw failure('ERR_OPTIONS', 'Global name must be a string', 'TypeError');
  }
  async #register(fn: HostFunction | HandleFunction, handles: boolean): Promise<Handle> {
    if (typeof fn !== 'function') throw failure('ERR_OPTIONS', 'Callback must be a function', 'TypeError');
    if (this.#functions.size >= 10_000) throw failure('ERR_LIMIT', 'Host function limit reached', 'RangeError');
    const id = this.#nextFunction++;
    this.#functions.set(id, { fn, handles });
    try { return this._wrap(await this._request('function', [id, !handles])); }
    catch (error) { this.#functions.delete(id); throw error; }
  }
  async createFunction(fn: HandleFunction): Promise<Handle> { return this.#register(fn, true); }
  async expose(name: string, fn: HostFunction): Promise<void> {
    this.#name(name);
    const handle = await this.#register(fn, false);
    try { await this.set(name, handle); } finally { await handle.dispose(); }
  }
  async #hostCall(callId: number, functionId: number, thisId: number, args: number[], copied?: WireValue[]): Promise<void> {
    if (this.#closed) return;
    const receiver = copied === undefined ? this._wrap(thisId) : undefined;
    const handles = copied === undefined ? args.map((id) => this._wrap(id)) : [];
    try {
      const registration = this.#functions.get(functionId);
      if (!registration) throw failure('ERR_CALLBACK', 'Host callback is no longer registered');
      const result = registration.handles
        ? await (registration.fn as HandleFunction)(receiver!, handles)
        : await (registration.fn as HostFunction)(...(copied === undefined
          ? await Promise.all(handles.map((handle) => handle.dump()))
          : copied.map(value => decode(value))));
      if (!this.#closed) this.#transport!.settle(callId, this._input(result));
    } catch (error) {
      if (!this.#closed) this.#transport!.settle(callId, absent, toWire(error));
    } finally {
      receiver?._invalidate();
      for (const handle of handles) handle._invalidate();
    }
  }
  async dispose(): Promise<void> { await this.#retire(failure('ERR_DISPOSED', 'Sandbox is disposed', 'DisposedError')); }
  async [Symbol.asyncDispose](): Promise<void> { await this.dispose(); }
}

/** An owned reference to a value in one sandbox. */
export class Handle {
  #sandbox: Sandbox;
  #id: number;
  #disposed = false;
  private constructor(sandbox: Sandbox, id: number, token: symbol) {
    if (token !== owner) throw new TypeError('Use sandbox.handle() or sandbox.evaluateHandle()');
    this.#sandbox = sandbox; this.#id = id;
  }
  /** @internal */
  static _from(sandbox: Sandbox, id: number): Handle { return new Handle(sandbox, id, owner); }
  get disposed(): boolean { return this.#disposed || this.#sandbox.disposed; }
  /** @internal */
  _input(sandbox: Sandbox): Input {
    if (sandbox !== this.#sandbox) throw failure('ERR_HANDLE', 'Handle belongs to another sandbox', 'InvalidHandleError');
    if (this.disposed) throw failure('ERR_HANDLE', 'Handle is disposed', 'InvalidHandleError');
    return { handle: this.#id };
  }
  /** @internal */
  _invalidate(): void { this.#disposed = true; }
  #live(): number { this._input(this.#sandbox); return this.#id; }
  #key(key: PropertyKey): Input {
    if (!(key instanceof Handle) && typeof key !== 'string' && typeof key !== 'number') throw failure('ERR_OPTIONS', 'Property key must be a string, number or symbol handle', 'TypeError');
    return this.#sandbox._input(key);
  }
  async type(): Promise<GuestType> { return this.#sandbox._request('type', [this.#live()]); }
  async dump<T = unknown>(options: ExecutionOptions = {}): Promise<T> { return decode(await this.#sandbox._request('dump', [this.#live()], options) as WireValue) as T; }
  async dup(): Promise<Handle> { return this.#sandbox._wrap(await this.#sandbox._request('dup', [this.#live()])); }
  async get(key: PropertyKey, options: ExecutionOptions = {}): Promise<Handle> { return this.#sandbox._wrap(await this.#sandbox._request('get', [this.#live(), this.#key(key)], options)); }
  async set(key: PropertyKey, value: unknown, options: ExecutionOptions = {}): Promise<void> { await this.#sandbox._request('set', [this.#live(), this.#key(key), this.#sandbox._input(value)], options); }
  async has(key: PropertyKey): Promise<boolean> { return this.#sandbox._request('has', [this.#live(), this.#key(key)]); }
  async delete(key: PropertyKey): Promise<boolean> { return this.#sandbox._request('delete', [this.#live(), this.#key(key)]); }
  async keys(): Promise<string[]> { return this.#sandbox._request('keys', [this.#live()]); }
  async equals(value: unknown): Promise<boolean> { return this.#sandbox._request('equals', [this.#live(), this.#sandbox._input(value)]); }
  async call(thisValue: unknown = undefined, args: readonly unknown[] = [], options: ExecutionOptions = {}): Promise<Handle> {
    if (!Array.isArray(args)) throw failure('ERR_OPTIONS', 'Arguments must be an array', 'TypeError');
    return this.#sandbox._wrap(await this.#sandbox._request('call', [this.#live(), this.#sandbox._input(thisValue), args.map((arg) => this.#sandbox._input(arg))], options));
  }
  async invoke(key: PropertyKey, args: readonly unknown[] = [], options: ExecutionOptions = {}): Promise<Handle> {
    if (!Array.isArray(args)) throw failure('ERR_OPTIONS', 'Arguments must be an array', 'TypeError');
    return this.#sandbox._wrap(await this.#sandbox._request('invoke', [this.#live(), this.#key(key), args.map((arg) => this.#sandbox._input(arg))], options));
  }
  async construct(args: readonly unknown[] = [], options: ExecutionOptions = {}): Promise<Handle> {
    if (!Array.isArray(args)) throw failure('ERR_OPTIONS', 'Arguments must be an array', 'TypeError');
    return this.#sandbox._wrap(await this.#sandbox._request('construct', [this.#live(), args.map((arg) => this.#sandbox._input(arg))], options));
  }
  async await(options: ExecutionOptions = {}): Promise<Handle> {
    return this.#sandbox._wrap(await this.#sandbox._request('await', [this.#live()], options));
  }
  async dispose(): Promise<void> {
    if (this.disposed) { this.#disposed = true; return; }
    this.#disposed = true;
    await this.#sandbox._request('release', [this.#id], {}, true);
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.dispose(); }
}

/** @internal */
export function createAPI(adapter: Adapter) {
  const createSandbox = (options: SandboxOptions = {}): Promise<Sandbox> => Sandbox._create(options, adapter);
  const withSandbox = async <T>(options: SandboxOptions, fn: (sandbox: Sandbox) => T | Promise<T>): Promise<T> => {
    const sandbox = await createSandbox(options);
    try { return await fn(sandbox); } finally { await sandbox.dispose(); }
  };
  const evaluate = async <T = unknown>(source: string, options: SandboxOptions & ExecutionOptions = {}): Promise<T> =>
    withSandbox(options, (sandbox) => sandbox.evaluate<T>(source, options));
  return { createSandbox, withSandbox, evaluate };
}
