import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { createFilesystem } from './filesystem.mjs';
import { createFetchHost } from './fetch-host.mjs';
import { createWebSocketHost } from './websocket-host.mjs';

let bundled;
export async function guestSource() {
  return bundled ??= (async () => {
    const result = await build({
      configFile: false, logLevel: 'silent',
      plugins: [{
        name: 'guest-web-streams',
        enforce: 'pre',
        resolveId(id, importer) {
          if ((id === './streams.cjs' && importer?.includes('/fetch-blob/')) || id.endsWith('/fetch-blob/streams.cjs')) return '\0guest-web-streams';
        },
        load(id) { if (id === '\0guest-web-streams') return 'export {};'; },
      }],
      build: {
        write: false, minify: true, target: 'es2022',
        lib: { entry: fileURLToPath(new URL('./guest.js', import.meta.url)), name: 'JssCapabilities', formats: ['iife'] },
      },
    });
    const chunks = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
    const chunk = chunks.find(item => item.type === 'chunk' && item.isEntry);
    if (!chunk) throw new Error('Guest bundle has no entry');
    return chunk.code;
  })();
}

export async function installCapabilities(sandbox, { root, allowedOrigins = [], console: logger = console } = {}) {
  const filesystem = await createFilesystem(root);
  let dispatch;
  let installed;
  let disposed = false;
  const timers = new Map();
  async function emit(kind, data) {
    if (disposed || !dispatch || sandbox.disposed) return;
    await using result = await dispatch.call(undefined, [kind, data]);
    await using settled = await result.await();
  }
  const http = createFetchHost({ emit, allowedOrigins });
  const sockets = createWebSocketHost({ emit, allowedOrigins });
  const handlers = {
    ...filesystem.handlers, ...http.handlers, ...sockets.handlers,
    console(level, args) { (logger[level] ?? logger.log).call(logger, ...args); },
    'timer.set'(id, milliseconds, repeat) {
      if (!Number.isSafeInteger(id) || id < 1 || !Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647) throw new TypeError('Invalid timer');
      if (timers.has(id) || timers.size >= 128) throw new RangeError('Timer limit exceeded');
      const fire = () => { if (!repeat) timers.delete(id); void emit('timer', { id }).catch(() => {}); };
      timers.set(id, (repeat ? setInterval : setTimeout)(fire, milliseconds));
    },
    'timer.clear'(id) { clearTimeout(timers.get(id)); timers.delete(id); },
  };
  const key = `__jss_host_${randomUUID().replaceAll('-', '')}`;
  await sandbox.expose(key, async (operation, ...args) => {
    if (disposed) throw new Error('Host capabilities have been disposed');
    if (!Object.hasOwn(handlers, operation)) throw new TypeError(`Unknown host capability: ${operation}`);
    return handlers[operation](...args);
  });
  try {
    installed = await sandbox.evaluateHandle(`(() => {
      const bridge = globalThis[${JSON.stringify(key)}];
      delete globalThis[${JSON.stringify(key)}];
      ${await guestSource()}
      return JssCapabilities.install(bridge);
    })()`, { filename: '<example-web-apis>', timeoutMs: 30_000 });
    dispatch = await installed.get('dispatch');
  } catch (error) {
    await http.dispose(); await sockets.dispose();
    throw error;
  }
  return {
    filesystem,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
      await http.dispose(); await sockets.dispose();
      if (!sandbox.disposed && installed) {
        try { await using result = await installed.invoke('dispose'); } catch { /* Sandbox may already be retiring. */ }
      }
      await dispatch?.dispose(); await installed?.dispose();
    },
    async [Symbol.asyncDispose]() { await this.dispose(); },
  };
}
