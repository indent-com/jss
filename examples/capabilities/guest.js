import { installWebPrimitives } from './web-primitives.js';
import { installFetch } from './fetch-guest.js';
import { installWebSocket } from './websocket-guest.js';

/** Lives entirely in QuickJS; the bridge function is captured, never public. */
export function install(bridge) {
  let nextTimer = 1;
  const timers = new Map();
  const timer = (repeat, callback, milliseconds = 0, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('Timer callback must be a function');
    const id = nextTimer++;
    timers.set(id, { callback, args, repeat });
    void bridge('timer.set', id, Math.max(0, Math.min(Number(milliseconds) || 0, 2_147_483_647)), repeat).catch(() => timers.delete(id));
    return id;
  };
  const clear = id => { timers.delete(Number(id)); void bridge('timer.clear', Number(id)).catch(() => {}); };
  Object.assign(globalThis, {
    setTimeout: (callback, milliseconds, ...args) => timer(false, callback, milliseconds, ...args),
    setInterval: (callback, milliseconds, ...args) => timer(true, callback, milliseconds, ...args),
    clearTimeout: clear, clearInterval: clear,
    console: Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, (...args) => {
      void bridge('console', level, args).catch(() => {});
    }]))),
    fs: Object.freeze(Object.fromEntries(['readText', 'readBytes', 'writeText', 'writeBytes', 'WriteBytes', 'glob', 'stat',
      'readDir', 'mkdir', 'remove', 'rename', 'copy', 'exists'].map(name => [name, (...args) => bridge(`fs.${name}`, ...args)]))),
  });
  const primitives = installWebPrimitives();
  const http = installFetch(bridge, primitives);
  const sockets = installWebSocket(bridge, primitives);
  Object.assign(globalThis, { fetch: http.fetch, Request: http.Request, Response: http.Response, Headers: http.Headers,
    WebSocket: sockets.WebSocket, CloseEvent: sockets.CloseEvent });
  return {
    dispatch(kind, data) {
      if (kind === 'timer') {
        const entry = timers.get(data.id);
        if (!entry) return;
        if (!entry.repeat) timers.delete(data.id);
        try { entry.callback(...entry.args); }
        catch (error) { console.error(String(error)); }
      } else if (kind.startsWith('ws.')) sockets.dispatch(kind, data);
      else http.dispatch(kind, data);
    },
    dispose() { timers.clear(); http.dispose(); sockets.dispose(); primitives.dispose?.(); },
  };
}
