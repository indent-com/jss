/** Install inside QuickJS. The bridge and socket table stay in this closure. */
export function installWebSocket(bridge, primitives, { maxBufferedBytes = 8 * 1024 * 1024 } = {}) {
  const { URL, EventTarget, Event, MessageEvent, DOMException, Blob, TextEncoder, TextDecoder } = primitives;
  const CHUNK_SIZE = 64 * 1024;
  const encoder = new TextEncoder();
  const readBlob = Blob.prototype.arrayBuffer;
  const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size').get;
  const sockets = new Map();
  let nextId = 1;
  let disposed = false;
  let dispatchSocket;
  let retireSocket;
  const string = (value) => {
    if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol to a string');
    return String(value);
  };
  const usvString = (value) => {
    const text = string(value);
    return text.toWellFormed();
  };
  // The encoding ponyfill builds a temporary number array. Encode at most one
  // bridge chunk at a time so large strings stay within the guest heap budget.
  function pointBytes(text, index) {
    const code = text.charCodeAt(index);
    return code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? 4 : 3;
  }
  function utf8Length(text) {
    let size = 0;
    for (let i = 0; i < text.length; i++) {
      const bytes = pointBytes(text, i);
      size += bytes;
      if (bytes === 4) i++;
    }
    return size;
  }
  function* textChunks(text) {
    let start = 0, size = 0;
    for (let i = 0; i < text.length; i++) {
      const bytes = pointBytes(text, i);
      if (size + bytes > CHUNK_SIZE) {
        yield encoder.encode(text.slice(start, i));
        start = i; size = 0;
      }
      size += bytes;
      if (bytes === 4) i++;
    }
    yield encoder.encode(text.slice(start));
  }
  const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const clampCode = (value) => {
    const number = +value;
    if (Number.isNaN(number)) return 0;
    const clamped = Math.min(65535, Math.max(0, number));
    const lower = Math.floor(clamped);
    return clamped - lower === 0.5 ? lower + (lower % 2) : Math.round(clamped);
  };
  class CloseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      Object.defineProperties(this, {
        wasClean: { enumerable: true, value: Boolean(init.wasClean) },
        code: { enumerable: true, value: (+init.code || 0) & 0xffff },
        reason: { enumerable: true, value: string(init.reason === undefined ? '' : init.reason) },
      });
    }
  }
  Object.defineProperty(CloseEvent.prototype, Symbol.toStringTag, { value: 'CloseEvent', configurable: true });
  const ActualCloseEvent = primitives.CloseEvent ?? CloseEvent;

  class WebSocket extends EventTarget {
    #id;
    #url;
    #state = 0;
    #protocol = '';
    #extensions = '';
    #binaryType = 'blob';
    #pending = new Map();
    #pendingBytes = 0;
    #hostBuffered = 0;
    #discardedBytes = 0;
    #sequence = 0;
    #snapshot = 0;
    #commands = Promise.resolve();
    #handlers = new Map();
    #incoming = null;

    constructor(input, protocols = []) {
      super();
      if (!arguments.length) throw new TypeError('WebSocket URL is required');
      if (disposed) throw new DOMException('WebSocket capability is disposed', 'InvalidStateError');
      const inputURL = usvString(input);
      let url;
      try { url = new URL(inputURL); }
      catch { throw new DOMException('Invalid WebSocket URL', 'SyntaxError'); }
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (!['ws:', 'wss:'].includes(url.protocol) || url.href.includes('#')) {
        throw new DOMException('WebSocket URLs require ws: or wss: and no fragment', 'SyntaxError');
      }
      const values = typeof protocols === 'object' && protocols !== null
        ? Array.from(protocols[Symbol.iterator]()).map(string)
        : [string(protocols)];
      if (values.some((value) => !token.test(value)) || new Set(values).size !== values.length) {
        throw new DOMException('Invalid or duplicate WebSocket protocol', 'SyntaxError');
      }
      this.#id = nextId++;
      this.#url = url.href;
      sockets.set(this.#id, this);
      this.#enqueue(async () => this.#ack(await bridge('ws.open', this.#id, this.#url, values)));
    }

    get url() { return this.#url; }
    get readyState() { return this.#state; }
    get protocol() { return this.#protocol; }
    get extensions() { return this.#extensions; }
    get bufferedAmount() { return this.#pendingBytes + this.#hostBuffered + this.#discardedBytes; }
    get binaryType() { return this.#binaryType; }
    set binaryType(value) {
      const converted = string(value);
      if (converted === 'blob' || converted === 'arraybuffer') this.#binaryType = converted;
    }

    #ack(value) {
      if (this.#state === WebSocket.CLOSED || !value || value.snapshot <= this.#snapshot) return;
      this.#snapshot = value.snapshot;
      this.#hostBuffered = value.bufferedAmount;
      for (const [sequence, size] of this.#pending) {
        if (sequence <= value.ack) {
          this.#pending.delete(sequence);
          this.#pendingBytes -= size;
        }
      }
    }
    #enqueue(operation) {
      this.#commands = this.#commands.then(() => {
        if (!disposed && this.#state !== WebSocket.CLOSED) return operation();
      }).catch(() => this.#fail());
    }
    #retire() {
      this.#state = WebSocket.CLOSED;
      this.#incoming = null;
      this.#discardedBytes += this.#pendingBytes;
      this.#pendingBytes = 0;
      this.#pending.clear();
      sockets.delete(this.#id);
    }
    #fail() {
      if (this.#state === WebSocket.CLOSED || disposed) return;
      this.#retire();
      Promise.resolve().then(() => bridge('ws.close', this.#id, 4000, 'WebSocket bridge failed')).catch(() => {});
      this.dispatchEvent(new Event('error'));
      this.dispatchEvent(new ActualCloseEvent('close', { code: 1006, reason: '', wasClean: false }));
    }
    #getHandler(type) { return this.#handlers.get(type)?.callback ?? null; }
    #setHandler(type, value) {
      const old = this.#handlers.get(type);
      const callback = typeof value === 'function' ? value : null;
      if (old && callback) { old.callback = callback; return; }
      if (old) { this.removeEventListener(type, old.listener); this.#handlers.delete(type); }
      if (callback) {
        const entry = { callback, listener: (event) => {
          if (entry.callback.call(this, event) === false) event.preventDefault();
        } };
        this.#handlers.set(type, entry);
        this.addEventListener(type, entry.listener);
      }
    }
    get onopen() { return this.#getHandler('open'); }
    set onopen(value) { this.#setHandler('open', value); }
    get onmessage() { return this.#getHandler('message'); }
    set onmessage(value) { this.#setHandler('message', value); }
    get onerror() { return this.#getHandler('error'); }
    set onerror(value) { this.#setHandler('error', value); }
    get onclose() { return this.#getHandler('close'); }
    set onclose(value) { this.#setHandler('close', value); }

    send(value) {
      if (!arguments.length) throw new TypeError('WebSocket.send requires data');
      let data;
      let bytes;
      let blob;
      let text = false;
      if (value instanceof Blob) {
        blob = value;
        bytes = blobSize.call(value);
      } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        data = value instanceof ArrayBuffer
          ? new Uint8Array(value.slice(0))
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
        bytes = data.byteLength;
      } else {
        text = true;
        data = usvString(value);
        bytes = utf8Length(data);
      }
      if (this.#state === WebSocket.CONNECTING) throw new DOMException('WebSocket is connecting', 'InvalidStateError');
      if (this.#state !== WebSocket.OPEN) { this.#discardedBytes += bytes; return; }
      if (this.bufferedAmount + bytes > maxBufferedBytes) {
        this.close(4009, 'WebSocket send buffer limit exceeded');
        this.#fail();
        return;
      }
      const sequence = ++this.#sequence;
      this.#pending.set(sequence, bytes);
      this.#pendingBytes += bytes;
      this.#enqueue(async () => {
        if (blob) data = new Uint8Array(await readBlob.call(blob));
        if (disposed || this.#state === WebSocket.CLOSED) return;
        this.#ack(await bridge('ws.sendStart', this.#id, sequence, text, bytes));
        let offset = 0;
        const parts = text ? textChunks(data) : (function* () {
          if (!data.byteLength) { yield data; return; }
          for (let index = 0; index < data.byteLength; index += CHUNK_SIZE) yield data.subarray(index, index + CHUNK_SIZE);
        })();
        for (const part of parts) {
          if (disposed || this.#state === WebSocket.CLOSED) return;
          this.#ack(await bridge('ws.sendChunk', this.#id, sequence, offset, part));
          offset += part.byteLength;
        }
      });
    }

    close(code, reason = '') {
      const convertedCode = code === undefined ? undefined : clampCode(code);
      const convertedReason = usvString(reason);
      if (convertedCode !== undefined && convertedCode !== 1000 && (convertedCode < 3000 || convertedCode > 4999)) {
        throw new DOMException('Close code must be 1000 or between 3000 and 4999', 'InvalidAccessError');
      }
      if (encoder.encode(convertedReason).byteLength > 123) throw new DOMException('Close reason exceeds 123 UTF-8 bytes', 'SyntaxError');
      if (this.#state === WebSocket.CLOSING || this.#state === WebSocket.CLOSED) return;
      this.#state = WebSocket.CLOSING;
      this.#incoming = null;
      this.#enqueue(async () => this.#ack(await bridge('ws.close', this.#id, convertedCode, convertedReason)));
    }

    static #dispatch(payload) {
      const socket = sockets.get(payload.id);
      if (!socket || disposed || socket.#state === WebSocket.CLOSED) return;
      socket.#ack(payload);
      if (payload.type === 'open') {
        if (socket.#state !== WebSocket.CONNECTING) return;
        socket.#protocol = payload.protocol;
        socket.#extensions = payload.extensions;
        socket.#state = WebSocket.OPEN;
        socket.dispatchEvent(new Event('open'));
      } else if (payload.type === 'messageChunk') {
        if (socket.#state !== WebSocket.OPEN) { socket.#incoming = null; return; }
        try {
          if (!Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > maxBufferedBytes ||
              !Number.isSafeInteger(payload.offset) || payload.offset < 0 || !(payload.bytes instanceof Uint8Array) ||
              payload.bytes.byteLength > CHUNK_SIZE || typeof payload.text !== 'boolean') throw new TypeError('Invalid WebSocket message');
          if (payload.offset === 0) {
            if (socket.#incoming) throw new TypeError('Interleaved WebSocket messages');
            socket.#incoming = { message: payload.message, size: payload.size, offset: 0, text: payload.text,
              bytes: payload.text ? null : new Uint8Array(payload.size), parts: payload.text ? [] : null,
              decoder: payload.text ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : null };
          }
          const incoming = socket.#incoming;
          if (!incoming || incoming.message !== payload.message || incoming.offset !== payload.offset ||
              incoming.size !== payload.size || incoming.text !== payload.text ||
              incoming.offset + payload.bytes.byteLength > incoming.size) throw new TypeError('Invalid WebSocket message chunk');
          incoming.offset += payload.bytes.byteLength;
          if (Boolean(payload.done) !== (incoming.offset === incoming.size)) throw new TypeError('Invalid WebSocket message boundary');
          if (incoming.text) incoming.parts.push(incoming.decoder.decode(payload.bytes, { stream: !payload.done }));
          else incoming.bytes.set(payload.bytes, payload.offset);
          if (!payload.done) return;
          socket.#incoming = null;
          const data = incoming.text ? incoming.parts.join('')
            : socket.#binaryType === 'blob' ? new Blob([incoming.bytes]) : incoming.bytes.buffer;
          socket.dispatchEvent(new MessageEvent('message', { data, origin: payload.origin }));
        } catch { socket.#fail(); }
      } else if (payload.type === 'error') {
        socket.dispatchEvent(new Event('error'));
      } else if (payload.type === 'close') {
        socket.#retire();
        socket.dispatchEvent(new ActualCloseEvent('close', payload));
      }
    }
    static {
      dispatchSocket = (payload) => WebSocket.#dispatch(payload);
      retireSocket = (socket) => { socket.#retire(); };
    }
  }

  for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    for (const target of [WebSocket, WebSocket.prototype]) Object.defineProperty(target, name, { value, enumerable: true });
  }
  Object.defineProperty(WebSocket.prototype, Symbol.toStringTag, { value: 'WebSocket', configurable: true });
  return {
    WebSocket,
    CloseEvent: ActualCloseEvent,
    dispatch(kind, payload) { if (kind === 'ws.event') dispatchSocket(payload); },
    dispose() {
      disposed = true;
      for (const socket of sockets.values()) retireSocket(socket);
      sockets.clear();
    },
  };
}
