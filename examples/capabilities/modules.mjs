import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_GRAPH_BYTES = 16 * 1024 * 1024;
const MAX_MODULES = 128;
const ROOT = 'jss:/';
const HELPER = 'jss:/.__runner/imports.js';
const REPL = 'jss:/__repl__.ts';
const extensions = /\.(?:m?js|m?ts)$/i;
const sourceTypes = new Set(['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);
const typescriptTypes = new Set(['text/typescript', 'application/typescript']);


/** Resolve, typecheck and register JS/TS; evaluating a returned name remains the caller's choice. */
export async function createModuleLoader({
  sandbox,
  filesystem,
  allowedOrigins = [],
  globalsPath = fileURLToPath(new URL('./globals.d.ts', import.meta.url)),
  compilerTimeoutMs = 15_000,
}) {
  if (!Number.isSafeInteger(compilerTimeoutMs) || compilerTimeoutMs < 1 || compilerTimeoutMs > 2_147_483_647) throw new RangeError('Invalid compiler timeout');
  const origins = new Set(allowedOrigins.map((value) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Module origins require HTTP(S)');
    return url.origin;
  }));
  const records = new Map();
  const sources = new Map();
  const pendingReads = new Map();
  const aliases = new Map();
  const controllers = new Set();
  const globalSource = await fs.readFile(globalsPath, 'utf8');
  let totalBytes = 0;
  let nextVirtualFile = 0;
  let pendingLoads = 0;
  let disposed = false;
  let serial = Promise.resolve();
  let compilerSerial = Promise.resolve();
  let activeCompiler;


  function alive() { if (disposed) throw new Error('Module loader is disposed'); }
  function runCompiler(data) {
    const result = compilerSerial.then(async () => {
      alive();
      const worker = new Worker(new URL('./modules-compiler.mjs', import.meta.url), {
        workerData: data,
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
      });
      activeCompiler = worker;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`TypeScript compiler exceeded ${compilerTimeoutMs} ms`)), compilerTimeoutMs);
          worker.once('message', (message) => {
            if (!message.error) resolve(message.value);
            else {
              const error = new Error(message.error.message);
              error.name = message.error.name;
              reject(error);
            }
          });
          worker.once('error', reject);
          worker.once('exit', (code) => reject(new Error(`TypeScript compiler exited before producing a result (${code})`)));
        });
      } finally {
        clearTimeout(timer);
        await worker.terminate();
        worker.removeAllListeners();
        if (activeCompiler === worker) activeCompiler = undefined;
      }
    });
    compilerSerial = result.catch(() => {});
    return result;
  }
  function compilerRecords(values) {
    return [...values].map(({ url, filename, source, typescript, declaration, dependencies }) => ({
      url, filename, source, typescript, declaration, dependencies: [...dependencies],
    }));
  }
  function canonical(specifier, base = undefined) {
    if (typeof specifier !== 'string' || !specifier || specifier.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(specifier)) {
      throw new TypeError('Module specifiers must be nonempty strings without control characters or backslashes');
    }
    const hasScheme = /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
    if (base && !hasScheme && !specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
      throw new TypeError(`Bare module imports are not supported: ${specifier}`);
    }
    const url = new URL(specifier, base ?? ROOT);
    if (url.hash || url.href.includes('#')) throw new TypeError('Module URL fragments are not supported');
    if (url.protocol === 'jss:') {
      if (url.host || url.search) throw new TypeError('Local modules cannot contain hosts or queries');
      if (!extensions.test(url.pathname)) throw new TypeError('Local modules require an explicit JavaScript or TypeScript extension');
      if (url.pathname.startsWith('/.__runner/')) throw new Error('The runner module namespace is private');
    } else {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Only local and HTTP(S) modules are supported');
      if (!origins.has(url.origin)) throw new Error(`Module origin is not allowed: ${url.origin}`);
      const name = url.pathname.split('/').at(-1);
      if (name.includes('.') && !extensions.test(name)) throw new TypeError(`Unsupported module extension: ${name}`);
    }
    return aliases.get(url.href) ?? url.href;
  }

  async function fetchSource(input) {
    let url = input;
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('Module fetch timed out')), 15_000);
    timer.unref?.();
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        alive();
        const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects === 5) throw new Error('Invalid or excessive module redirects');
          url = canonical(new URL(location, url).href);
          if (!url.startsWith('http:') && !url.startsWith('https:')) throw new TypeError('HTTP modules can only redirect to HTTP(S)');
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Module fetch failed (${response.status}): ${url}`); }
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        const path = new URL(url).pathname;
        if (!extensions.test(path) && !sourceTypes.has(type) && !typescriptTypes.has(type)) {
          await response.body?.cancel();
          throw new TypeError('Extensionless HTTP modules require a JavaScript or TypeScript Content-Type');
        }
        if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) {
          await response.body?.cancel();
          throw new RangeError('Module source exceeds 1 MiB');
        }
        const chunks = [];
        let bytes = 0;
        if (response.body) {
          for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > MAX_SOURCE_BYTES) { controller.abort(); throw new RangeError('Module source exceeds 1 MiB'); }
            chunks.push(chunk);
          }
        }
        return {
          url,
          source: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
          bytes,
          typescript: /\.m?ts$/i.test(path) || typescriptTypes.has(type),
        };
      }
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }

  async function readSource(url) {
    if (!url.startsWith(ROOT)) return fetchSource(url);
    const relative = decodeURIComponent(new URL(url).pathname.slice(1));
    const path = await filesystem.pathFor(relative);
    await using file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (!info.isFile()) throw new TypeError('A module must be a regular file');
    if (info.size > MAX_SOURCE_BYTES) throw new RangeError('Module source exceeds 1 MiB');
    const data = new Uint8Array(MAX_SOURCE_BYTES + 1);
    let bytes = 0;
    while (bytes < data.length) {
      const result = await file.read(data, bytes, data.length - bytes, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_SOURCE_BYTES) throw new RangeError('Module source exceeds 1 MiB');
    return { url, source: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytes)), bytes, typescript: /\.m?ts$/i.test(path) };
  }

  async function sourceFor(url) {
    url = aliases.get(url) ?? url;
    if (sources.has(url)) return sources.get(url);
    if (pendingReads.has(url)) return pendingReads.get(url);
    if (sources.size + pendingReads.size >= MAX_MODULES) throw new RangeError('Module graph exceeds 128 modules');
    const promise = readSource(url).then((value) => {
      alive();
      aliases.set(url, value.url);
      if (sources.has(value.url)) return sources.get(value.url);
      if (totalBytes + value.bytes > MAX_GRAPH_BYTES) throw new RangeError('Module graph exceeds 16 MiB');
      sources.set(value.url, value);
      totalBytes += value.bytes;
      return value;
    }).finally(() => pendingReads.delete(url));
    pendingReads.set(url, promise);
    return promise;
  }

  async function collect(url, staged) {
    alive();
    url = aliases.get(url) ?? url;
    if (records.has(url)) return records.get(url);
    if (staged.has(url)) return staged.get(url);
    const value = await sourceFor(url);
    alive();
    if (records.has(value.url)) return records.get(value.url);
    if (staged.has(value.url)) return staged.get(value.url);
    const declaration = new URL(value.url).pathname.endsWith('.d.ts');
    const extension = declaration ? '.d.ts' : value.typescript ? '.ts' : '.js';
    const filename = `/__jss_modules/${nextVirtualFile++}${extension}`;
    const record = { ...value, filename, declaration, dependencies: new Map(), registered: false };
    staged.set(value.url, record);
    value.inspection ??= runCompiler({ operation: 'inspect', source: value.source, url: value.url, typescript: value.typescript });
    for (const [specifier, runtime] of await value.inspection) {
      const dependency = await collect(canonical(specifier, value.url), staged);
      if (dependency.declaration && runtime) throw new TypeError('Declaration files require import type or export type');
      record.dependencies.set(specifier, dependency.url);
    }
    return record;
  }

  async function registerGraph(entry, staged) {
    alive();
    const additions = [...staged.values()].filter(record => !records.has(record.url));
    try {
      if (!additions.length) return entry.url;
      const graph = new Map([...records, ...additions.map(record => [record.url, record])]);
      const compiled = await runCompiler({ operation: 'compile', records: compilerRecords(graph.values()), globals: globalSource, emit: additions.map(record => record.url) });
      for (const [url, source] of compiled) {
        alive();
        await sandbox.defineModule(url, source);
        graph.get(url).registered = true;
      }
      for (const record of additions) records.set(record.url, record);
      return entry.url;
    } catch (error) {
      // Failed typechecking must not poison later loads. Registered sources are immutable.
      if (additions.some(record => record.registered)) disposed = true;
      throw error;
    }
  }
  async function load(specifier, base) {
    alive();
    if (pendingLoads >= MAX_MODULES) throw new RangeError('Too many pending module loads');
    pendingLoads++;
    try {
      const staged = new Map();
      const entry = await collect(canonical(specifier, base), staged);
      if (entry.declaration) throw new TypeError('Declaration files cannot be executed');
      const result = serial.then(() => registerGraph(entry, staged));
      serial = result.catch(() => {});
      return await result;
    } finally { pendingLoads--; }
  }

  async function prepareRepl(source, priorSources = []) {
    alive();
    if (typeof source !== 'string' || !Array.isArray(priorSources) || priorSources.some(value => typeof value !== 'string')) throw new TypeError('REPL input and history must be strings');
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) throw new RangeError('REPL cell exceeds 1 MiB');
    if (priorSources.length >= 1024) throw new RangeError('REPL history exceeds 1024 cells; clear the session');
    const combined = [...priorSources, source].join('\n;\n');
    const historyBytes = Buffer.byteLength(combined);
    if (historyBytes + totalBytes > MAX_GRAPH_BYTES) throw new RangeError('REPL history and modules exceed 16 MiB; clear the session');
    const dependencies = await runCompiler({ operation: 'inspect', source: combined, typescript: true, url: REPL });
    const staged = new Map();
    const repl = { url: REPL, filename: '/__jss_repl__.ts', source: combined, typescript: true, declaration: false, dependencies: new Map() };
    for (const [specifier, runtime] of dependencies) {
      const url = canonical(specifier, REPL);
      if (url === REPL) throw new TypeError('The REPL virtual module cannot import itself');
      const dependency = await collect(url, staged);
      if (dependency.declaration && runtime) throw new TypeError('Declaration files require import type or export type');
      repl.dependencies.set(specifier, dependency.url);
    }
    const result = serial.then(async () => {
      alive();
      if (historyBytes + totalBytes > MAX_GRAPH_BYTES) throw new RangeError('REPL history and modules exceed 16 MiB; clear the session');
      const additions = [...staged.values()].filter(record => !records.has(record.url));
      const graph = new Map([...records, ...additions.map(record => [record.url, record]), [REPL, repl]]);
      const prepared = await runCompiler({
        operation: 'repl', records: compilerRecords(graph.values()), globals: globalSource,
        emit: additions.map(record => record.url), replURL: REPL, cell: source, cellIndex: priorSources.length,
        importHelper: replImportName,
      });
      try {
        for (const [url, code] of prepared.modules) {
          alive();
          await sandbox.defineModule(url, code);
          graph.get(url).registered = true;
        }
        for (const record of additions) records.set(record.url, record);
      } catch (error) {
        if (additions.some(record => record.registered)) disposed = true;
        throw error;
      }
      return { code: prepared.code };
    });
    serial = result.catch(() => {});
    return result;
  }

  const globalName = `__jss_module_load_${randomBytes(16).toString('hex')}`;
  const replImportName = `__jss_repl_import_${randomBytes(16).toString('hex')}`;
  await sandbox.expose(globalName, (specifier, base) => load(specifier, base));
  await sandbox.defineModule(HELPER, `
    const load = globalThis[${JSON.stringify(globalName)}];
    delete globalThis[${JSON.stringify(globalName)}];
    export async function importModule(specifier, base, options) {
      if (typeof specifier === 'symbol') throw new TypeError('A module specifier cannot be a Symbol');
      specifier = String(specifier);
      if (options !== undefined) {
        if (options === null || !['object', 'function'].includes(typeof options)) throw new TypeError('Import options must be an object');
        const attributes = options.with;
        if (attributes !== undefined) {
          if (attributes === null || typeof attributes !== 'object') throw new TypeError('Import attributes must be an object');
          if (Object.keys(attributes).length) throw new TypeError('Import attributes are not supported; only JavaScript and TypeScript modules are available');
        }
      }
      const url = await load(specifier, base);
      return import(url);
    }
  `);
  // Capture the callback before users can inspect globals or execute any dependency.
  {
    await using helper = await sandbox.evaluateModuleHandle(HELPER);
    await using importFunction = await helper.get('importModule');
    await sandbox.set(replImportName, importFunction);
    await sandbox.evaluate(`Object.defineProperty(globalThis, ${JSON.stringify(replImportName)}, { enumerable: false, writable: false }); void 0;`);
  }

  return {
    load,
    prepareRepl,
    async dispose() {
      disposed = true;
      if (activeCompiler) await activeCompiler.terminate();
      for (const controller of controllers) controller.abort(new Error('Module loader is disposed'));
      controllers.clear();
      records.clear();
      sources.clear();
      pendingReads.clear();
      aliases.clear();
      try { await sandbox.evaluate(`delete globalThis[${JSON.stringify(replImportName)}]`); } catch {}
    },
    async [Symbol.asyncDispose]() { await this.dispose(); },
  };
}
