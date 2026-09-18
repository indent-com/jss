/** Browser WebSocket transport for the capability example; no Node objects cross the bridge. */
export function createWebSocketHost({
  emit,
  WebSocket: Implementation = globalThis.WebSocket,
  allowedOrigins = [],
  maxSockets = 16,
  maxQueuedEvents = 128,
  maxBufferedBytes = 8 * 1024 * 1024,
} = {}) {
  const CHUNK_SIZE = 64 * 1024;
  if (typeof emit !== 'function' || typeof Implementation !== 'function') {
    throw new TypeError('WebSocket host requires emit and a WebSocket implementation');
  }
  for (const value of [maxSockets, maxQueuedEvents, maxBufferedBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid WebSocket limit');
  }
  const normalize = (value) => {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    return url;
  };
  const origins = new Set(allowedOrigins.map((origin) => normalize(origin).origin));
  const sockets = new Map();
  const closed = new Map();
  let disposed = false;
  let queuedEvents = 0;
  let queuedBytes = 0;

  const snapshot = (entry) => ({
    snapshot: ++entry.snapshot,
    ack: entry.ack,
    bufferedAmount: entry.socket.bufferedAmount,
  });
  const detach = (entry) => {
    clearTimeout(entry.poll);
    for (const [type, listener] of Object.entries(entry.listeners)) {
      entry.socket.removeEventListener(type, listener);
    }
    sockets.delete(entry.id);
    // A closed socket never retains a partially assembled message buffer.
    if (entry.transfer) entry.transfer.bytes = null;
  };
  const rememberClosed = (entry) => {
    const transfer = entry.transfer;
    closed.set(entry.id, { ...snapshot(entry), transfer: transfer && {
      sequence: transfer.sequence, size: transfer.size, received: transfer.received, text: transfer.text,
    } });
    // Preserve races with commands already in flight without retaining native sockets.
    if (closed.size > maxQueuedEvents) closed.delete(closed.keys().next().value);
  };
  const closedSnapshot = (entry) => ({ snapshot: entry.snapshot, ack: entry.ack, bufferedAmount: entry.bufferedAmount });
  const deliveryFailure = async (entry) => {
    if (entry.deliveryFailed || disposed) return;
    entry.deliveryFailed = entry.failed = true;
    detach(entry);
    rememberClosed(entry);
    try { entry.socket.close(4000, 'Event delivery failed'); } catch {}
    // One bounded best-effort attempt per terminal event, with small payloads.
    // Do not recursively queue failures behind the promise currently failing.
    for (const event of [{ type: 'error' }, { type: 'close', code: 1006, reason: '', wasClean: false }]) {
      try { if (!disposed) await emit('ws.event', { id: entry.id, ...event, ...snapshot(entry) }); } catch {}
    }
  };
  const queue = (entry, payload, bytes = 0, terminal = false) => {
    if (disposed || entry.failed && !terminal) return;
    if (!terminal && (queuedEvents >= maxQueuedEvents || queuedBytes + bytes > maxBufferedBytes)) {
      fail(entry, 'WebSocket event queue limit exceeded');
      return;
    }
    queuedEvents++;
    queuedBytes += bytes;
    entry.events = entry.events.then(async () => {
      if (disposed || entry.failed && !terminal) return;
      if (payload.type !== 'message') { await emit('ws.event', { id: entry.id, ...payload }); return; }
      // Reserve queue space for a whole message, but cross the value codec in
      // bounded chunks. The guest dispatches exactly one DOM message event.
      const { data, ...metadata } = payload;
      for (let offset = 0; ; offset += CHUNK_SIZE) {
        if (disposed || entry.failed) return;
        const end = Math.min(offset + CHUNK_SIZE, data.byteLength);
        await emit('ws.event', { id: entry.id, ...metadata, type: 'messageChunk',
          size: data.byteLength, offset, done: end === data.byteLength, bytes: data.subarray(offset, end) });
        if (end === data.byteLength) return;
      }
    }).catch(() => deliveryFailure(entry)).finally(() => {
      queuedEvents--;
      queuedBytes -= bytes;
    });
  };
  const fail = (entry, reason) => {
    if (entry.failed || disposed) return;
    entry.failed = true;
    detach(entry);
    try { entry.socket.close(4009, reason); } catch {}
    // Reserve these two terminal events even when the ordinary queue is full.
    queue(entry, { type: 'error', ...snapshot(entry) }, 0, true);
    queue(entry, { type: 'close', code: 1006, reason: '', wasClean: false, ...snapshot(entry) }, 0, true);
    rememberClosed(entry);
  };
  const poll = (entry) => {
    if (entry.poll || disposed || entry.failed) return;
    entry.poll = setTimeout(() => {
      entry.poll = undefined;
      if (disposed || entry.failed || !sockets.has(entry.id)) return;
      queue(entry, { type: 'buffer', ...snapshot(entry) });
      if (entry.socket.bufferedAmount > 0) poll(entry);
    }, 10);
    entry.poll.unref?.();
  };
  const requireSocket = (id) => {
    if (disposed) throw new Error('WebSocket capability is disposed');
    const entry = sockets.get(id);
    if (!entry) throw new Error('Unknown WebSocket');
    return entry;
  };

  const handlers = {
    'ws.open'(id, input, protocols) {
      if (disposed) throw new Error('WebSocket capability is disposed');
      if (!Number.isSafeInteger(id) || id < 1 || sockets.has(id) || closed.has(id)) throw new TypeError('Invalid WebSocket ID');
      if (sockets.size >= maxSockets) throw new RangeError('Too many open WebSockets');
      if (queuedEvents >= maxQueuedEvents) throw new RangeError('WebSocket event queue is full');
      const url = normalize(input);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.href.includes('#') || url.username || url.password) {
        throw new TypeError('Invalid WebSocket URL');
      }
      if (!origins.has(url.origin)) throw new Error(`WebSocket origin is not allowed: ${url.origin}`);
      if (!Array.isArray(protocols) || protocols.some((value) => typeof value !== 'string')) {
        throw new TypeError('Invalid WebSocket protocols');
      }
      const socket = new Implementation(url.href, protocols);
      socket.binaryType = 'arraybuffer';
      const entry = { id, socket, ack: 0, snapshot: 0, message: 0, transfer: null,
        events: Promise.resolve(), listeners: {}, failed: false, deliveryFailed: false };
      entry.listeners = {
        open() {
          queue(entry, { type: 'open', protocol: socket.protocol, extensions: socket.extensions, ...snapshot(entry) });
        },
        message(event) {
          const text = typeof event.data === 'string';
          const bytes = text ? Buffer.byteLength(event.data) : event.data.byteLength;
          if (bytes > maxBufferedBytes) { fail(entry, 'WebSocket message limit exceeded'); return; }
          // Native WebSocket obeys binaryType="arraybuffer". Copy before asynchronous delivery.
          const data = text ? Buffer.from(event.data, 'utf8') : new Uint8Array(event.data).slice();
          queue(entry, { type: 'message', message: ++entry.message, text, data, origin: url.origin, ...snapshot(entry) }, bytes);
        },
        error() {
          queue(entry, { type: 'error', ...snapshot(entry) });
        },
        close(event) {
          detach(entry);
          queue(entry, {
            type: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean, ...snapshot(entry),
          }, 0, true);
          rememberClosed(entry);
        },
      };
      sockets.set(id, entry);
      for (const [type, listener] of Object.entries(entry.listeners)) socket.addEventListener(type, listener);
      return snapshot(entry);
    },
    'ws.sendStart'(id, sequence, text, size) {
      if (typeof text !== 'boolean' || !Number.isSafeInteger(size) || size < 0 || size > maxBufferedBytes) throw new TypeError('Invalid WebSocket message size');
      const previous = closed.get(id);
      const entry = previous ? undefined : requireSocket(id);
      const target = previous ?? entry;
      if (!Number.isSafeInteger(sequence) || sequence <= target.ack || target.transfer) throw new TypeError('Invalid WebSocket send sequence');
      if (previous) {
        previous.transfer = { sequence, text, size, received: 0 };
        previous.snapshot++;
        return closedSnapshot(previous);
      }
      if (size + entry.socket.bufferedAmount > maxBufferedBytes) {
        fail(entry, 'WebSocket send buffer limit exceeded');
        throw new RangeError('WebSocket send buffer limit exceeded');
      }
      entry.transfer = { sequence, text, size, received: 0, bytes: new Uint8Array(size) };
      return snapshot(entry);
    },
    'ws.sendChunk'(id, sequence, offset, chunk) {
      const previous = closed.get(id);
      const entry = previous ? undefined : requireSocket(id);
      const target = previous ?? entry;
      const transfer = target.transfer;
      if (!transfer || transfer.sequence !== sequence || offset !== transfer.received ||
          !(chunk instanceof Uint8Array) || chunk.byteLength > CHUNK_SIZE ||
          offset + chunk.byteLength > transfer.size || (chunk.byteLength === 0 && transfer.size !== 0)) {
        throw new TypeError('Invalid WebSocket message chunk');
      }
      if (!previous) transfer.bytes.set(chunk, offset);
      transfer.received += chunk.byteLength;
      if (transfer.received !== transfer.size) {
        if (previous) { previous.snapshot++; return closedSnapshot(previous); }
        return snapshot(entry);
      }
      target.transfer = null;
      if (previous) {
        previous.ack = sequence;
        previous.bufferedAmount += transfer.size;
        previous.snapshot++;
        return closedSnapshot(previous);
      }
      if (transfer.size + entry.socket.bufferedAmount > maxBufferedBytes) {
        fail(entry, 'WebSocket send buffer limit exceeded');
        throw new RangeError('WebSocket send buffer limit exceeded');
      }
      entry.socket.send(transfer.text ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(transfer.bytes) : transfer.bytes);
      entry.ack = sequence;
      poll(entry);
      return snapshot(entry);
    },
    'ws.close'(id, code, reason) {
      if (closed.has(id)) { const previous = closed.get(id); previous.transfer = null; return closedSnapshot(previous); }
      const entry = requireSocket(id);
      entry.transfer = null;
      entry.socket.close(code, reason);
      return snapshot(entry);
    },
  };

  return {
    handlers,
    async dispose() {
      if (disposed) return;
      disposed = true;
      const current = [...sockets.values()];
      for (const entry of current) {
        detach(entry);
        try { entry.socket.close(1000, 'Sandbox disposed'); } catch {}
      }
      closed.clear();
      // Do not wait for a peer's closing handshake or a blocked guest callback.
    },
  };
}
