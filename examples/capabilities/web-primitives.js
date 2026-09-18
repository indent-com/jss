import { streams, encoding } from './web-primitives-init.js';
import { Blob } from 'fetch-blob';
import { File, FormData, formDataToBlob } from 'formdata-polyfill/esm.min.js';
import urls from 'whatwg-url';
import { Event, EventTarget } from 'event-target-shim';
import DOMException from 'domexception';

export function installWebPrimitives() {
  const blobURLs = new Map();
  let nextBlobURL = 1;
  const blobKey = value => { const url = new urls.URL(String(value)); url.hash = ''; return url.href; };
  Object.defineProperties(urls.URL, {
    createObjectURL: { configurable: true, writable: true, value(blob) {
      if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob');
      if (blobURLs.size >= 128) throw new RangeError('Too many live Blob URLs');
      const url = `blob:jss/${nextBlobURL++}-${Math.random().toString(36).slice(2)}`;
      blobURLs.set(url, blob);
      return url;
    } },
    revokeObjectURL: { configurable: true, writable: true, value(url) { try { blobURLs.delete(blobKey(url)); } catch { /* Revoking an unknown URL is a no-op. */ } } },
  });
  if (!Blob.prototype.bytes) Object.defineProperty(Blob.prototype, 'bytes', { configurable: true, writable: true, async value() { return new Uint8Array(await this.arrayBuffer()); } });
  class TextEncoderStream {
    #stream;
    constructor() {
      const encoder = new encoding.TextEncoder();
      let pending = '';
      this.#stream = new streams.TransformStream({
        transform(value, controller) {
          let text = pending + String(value);
          pending = /[\ud800-\udbff]$/.test(text) ? text.slice(-1) : '';
          if (pending) text = text.slice(0, -1);
          const bytes = encoder.encode(text);
          if (bytes.length) controller.enqueue(bytes);
        },
        flush(controller) { if (pending) controller.enqueue(encoder.encode(pending)); },
      });
    }
    get encoding() { return 'utf-8'; }
    get readable() { return this.#stream.readable; }
    get writable() { return this.#stream.writable; }
    get [Symbol.toStringTag]() { return 'TextEncoderStream'; }
  }
  class TextDecoderStream {
    #decoder;
    #stream;
    constructor(label = 'utf-8', options = {}) {
      this.#decoder = new encoding.TextDecoder(label, options);
      this.#stream = new streams.TransformStream({
        transform: (bytes, controller) => {
          const text = this.#decoder.decode(bytes, { stream: true });
          if (text) controller.enqueue(text);
        },
        flush: controller => { const text = this.#decoder.decode(); if (text) controller.enqueue(text); },
      });
    }
    get encoding() { return this.#decoder.encoding; }
    get fatal() { return this.#decoder.fatal; }
    get ignoreBOM() { return this.#decoder.ignoreBOM; }
    get readable() { return this.#stream.readable; }
    get writable() { return this.#stream.writable; }
    get [Symbol.toStringTag]() { return 'TextDecoderStream'; }
  }
  class MessageEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      Object.defineProperties(this, {
        data: { value: init.data ?? null, enumerable: true },
        origin: { value: String(init.origin ?? ''), enumerable: true },
        lastEventId: { value: String(init.lastEventId ?? ''), enumerable: true },
        source: { value: init.source ?? null, enumerable: true },
        ports: { value: Object.freeze(Array.from(init.ports ?? [])), enumerable: true },
      });
    }
    get [Symbol.toStringTag]() { return 'MessageEvent'; }
  }

  const token = {};
  const aborters = new WeakMap();
  const dependencies = new WeakMap();
  const removeDependencies = records => {
    for (const [source, listener] of records) source.deref()?.removeEventListener('abort', listener);
  };
  const dependencyFinalizer = new FinalizationRegistry(removeDependencies);
  function releaseSignal(signal) {
    const records = dependencies.get(signal);
    if (records) removeDependencies(records);
    dependencies.delete(signal);
    dependencyFinalizer.unregister(signal);
  }
  class AbortSignal extends EventTarget {
    #aborted = false;
    #reason;
    #onabort = null;
    constructor(key) {
      super();
      if (key !== token) throw new TypeError('Illegal constructor');
      aborters.set(this, reason => {
        if (this.#aborted) return;
        this.#aborted = true;
        this.#reason = reason === undefined ? new DOMException('The operation was aborted', 'AbortError') : reason;
        this.dispatchEvent(new Event('abort'));
      });
    }
    get aborted() { return this.#aborted; }
    get reason() { return this.#reason; }
    get onabort() { return this.#onabort; }
    set onabort(listener) {
      if (this.#onabort) this.removeEventListener('abort', this.#onabort);
      this.#onabort = typeof listener === 'function' ? listener : null;
      if (this.#onabort) this.addEventListener('abort', this.#onabort);
    }
    throwIfAborted() { if (this.#aborted) throw this.#reason; }
    static abort(reason) {
      const controller = new AbortController();
      controller.abort(reason);
      return controller.signal;
    }
    static timeout(milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError('Invalid timeout');
      const controller = new AbortController();
      if (typeof globalThis.setTimeout !== 'function') throw new TypeError('Timers must be installed for AbortSignal.timeout');
      globalThis.setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    }
    static any(signals) {
      const list = Array.from(signals);
      for (const signal of list) if (!(signal instanceof AbortSignal)) throw new TypeError('Expected AbortSignal');
      const signal = new AbortSignal(token);
      const reference = new WeakRef(signal);
      const records = [];
      for (const source of list) {
        if (source.aborted) { aborters.get(signal)(source.reason); removeDependencies(records); return signal; }
        const parent = new WeakRef(source);
        const listener = () => {
          const target = reference.deref();
          if (target) { aborters.get(target)(parent.deref()?.reason); releaseSignal(target); }
          else removeDependencies(records);
        };
        records.push([parent, listener]);
        source.addEventListener('abort', listener, { once: true });
      }
      dependencies.set(signal, records);
      dependencyFinalizer.register(signal, records, signal);
      return signal;
    }
    get [Symbol.toStringTag]() { return 'AbortSignal'; }
  }
  class AbortController {
    #signal = new AbortSignal(token);
    get signal() { return this.#signal; }
    abort(reason) { aborters.get(this.#signal)(reason); }
    get [Symbol.toStringTag]() { return 'AbortController'; }
  }

  const primitives = {
    ...streams, TextEncoder: encoding.TextEncoder, TextDecoder: encoding.TextDecoder,
    TextEncoderStream, TextDecoderStream,
    Blob, File, FormData, URL: urls.URL, URLSearchParams: urls.URLSearchParams,
    Event, EventTarget, MessageEvent, DOMException, AbortController, AbortSignal,
  };
  Object.assign(globalThis, primitives);
  return {
    ...primitives, formDataToBlob, releaseSignal,
    resolveBlobURL: url => blobURLs.get(blobKey(url)),
    dispose() { blobURLs.clear(); },
  };
}
