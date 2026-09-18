// A Fetch API adapter for the example realm, not a claim of Web Platform Test
// conformance. HTTP and multipart parsing run in Node; body streams run here.
export function installFetch(bridge, primitives, { maxBodyBytes = 8 * 1024 * 1024 } = {}) {
  const { ReadableStream, TransformStream, TextEncoder, TextDecoder, URL, URLSearchParams,
    Blob, File, FormData, formDataToBlob, AbortController, AbortSignal, DOMException } = primitives;
  const CHUNK_SIZE = 64 * 1024;
  const encoder = new TextEncoder();
  const bodies = new WeakMap();
  const headersState = new WeakMap();
  const requests = new Map();
  let nextId = 1;
  let disposed = false;
  function byteString(input) {
    const value = String(input);
    if (/[^\x00-\xff]/.test(value)) throw new TypeError('Expected a ByteString');
    return value;
  }
  function headerName(input) {
    const name = byteString(input);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new TypeError('Invalid HTTP header name');
    return name.toLowerCase();
  }
  function headerValue(input) {
    const value = byteString(input).replace(/^[\t ]+|[\t ]+$/g, '');
    if (/[\0\r\n]/.test(value)) throw new TypeError('Invalid HTTP header value');
    return value;
  }
  function requireArguments(count, expected) {
    if (count < expected) throw new TypeError(`Expected at least ${expected} arguments`);
  }
  function headerList(object, mutate = false) {
    const state = headersState.get(object);
    if (!state) throw new TypeError('Illegal Headers receiver');
    if (mutate && state.immutable) throw new TypeError('Headers are immutable');
    return state.list;
  }
  class Headers {
    constructor(init = undefined) {
      headersState.set(this, { list: [], immutable: false });
      if (init === undefined) return;
      if (init === null || (typeof init !== 'object' && typeof init !== 'function')) throw new TypeError('Expected a headers record or sequence');
      if (init[Symbol.iterator] !== undefined) {
        for (const entry of init) {
          if (entry === null || (typeof entry !== 'object' && typeof entry !== 'function')) throw new TypeError('Each header entry must be a sequence');
          const pair = Array.from(entry);
          if (pair.length !== 2) throw new TypeError('Each header entry must have two values');
          this.append(pair[0], pair[1]);
        }
      } else for (const key of Object.keys(init)) this.append(key, init[key]);
    }
    append(name, value) { requireArguments(arguments.length, 2); name = headerName(name); value = headerValue(value); headerList(this, true).push([name, value]); }
    delete(name) {
      requireArguments(arguments.length, 1);
      name = headerName(name);
      const list = headerList(this, true);
      for (let index = list.length - 1; index >= 0; index--) if (list[index][0] === name) list.splice(index, 1);
    }
    get(name) { requireArguments(arguments.length, 1); name = headerName(name); const values = headerList(this).filter(pair => pair[0] === name); return values.length ? values.map(pair => pair[1]).join(', ') : null; }
    getSetCookie() { return headerList(this).filter(pair => pair[0] === 'set-cookie').map(pair => pair[1]); }
    has(name) { requireArguments(arguments.length, 1); name = headerName(name); return headerList(this).some(pair => pair[0] === name); }
    set(name, value) {
      requireArguments(arguments.length, 2);
      name = headerName(name); value = headerValue(value);
      const list = headerList(this, true);
      let found = false;
      for (let index = 0; index < list.length; index++) if (list[index][0] === name) {
        if (found) list.splice(index--, 1);
        else { list[index][1] = value; found = true; }
      }
      if (!found) list.push([name, value]);
    }
    *entries() {
      for (let index = 0; ; index++) {
        const list = headerList(this);
        const names = [...new Set(list.map(pair => pair[0]))].sort();
        const sorted = names.flatMap(name => name === 'set-cookie' ? this.getSetCookie().map(value => [name, value]) : [[name, this.get(name)]]);
        if (index >= sorted.length) return;
        yield sorted[index];
      }
    }
    *keys() { for (const [name] of this.entries()) yield name; }
    *values() { for (const [, value] of this.entries()) yield value; }
    forEach(callback, receiver) { if (typeof callback !== 'function') throw new TypeError('Expected a callback'); for (const [name, value] of this.entries()) callback.call(receiver, value, name, this); }
    [Symbol.iterator]() { return this.entries(); }
    get [Symbol.toStringTag]() { return 'Headers'; }
  }
  function state(object) {
    const value = bodies.get(object);
    if (!value) throw new TypeError('Illegal Request or Response receiver');
    return value;
  }
  function disturbed(bodyState) {
    // The pinned Streams ponyfill owns this flag and sets it for read, cancel,
    // pipe and tee, including operations made directly through .body.
    return bodyState.used || Boolean(bodyState.body?._disturbed);
  }
  function usable(bodyState) {
    if (disturbed(bodyState) || bodyState.body?.locked) throw new TypeError('Body is already used or locked');
  }
  function byteStream(bytes) {
    return new ReadableStream({ type: 'bytes', start(controller) {
      if (bytes.byteLength) controller.enqueue(bytes.slice());
      controller.close();
    } });
  }
  function extract(body) {
    if (body === null || body === undefined) return { body: null, replayable: true, type: null, used: false };
    if (body instanceof ReadableStream) {
      if (body.locked || body._disturbed) throw new TypeError('Body stream is already used or locked');
      return { body, replayable: false, type: null, used: false };
    }
    if (body instanceof FormData) body = formDataToBlob(body, Blob);
    if (body instanceof Blob) return { body: body.stream(), replayable: true, type: body.type || null, used: false };
    let bytes;
    let type = null;
    if (body instanceof URLSearchParams) { bytes = encoder.encode(body.toString()); type = 'application/x-www-form-urlencoded;charset=UTF-8'; }
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body.slice(0));
    else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    else { bytes = encoder.encode(String(body)); type = 'text/plain;charset=UTF-8'; }
    return { body: byteStream(bytes), replayable: true, type, used: false };
  }
  async function* chunks(object, receiveReader) {
    const current = state(object);
    usable(current);
    if (!current.body) return;
    current.used = true;
    const reader = current.body.getReader();
    receiveReader?.(reader);
    let total = 0;
    let complete = false;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) { complete = true; return; }
        if (!(item.value instanceof Uint8Array)) throw new TypeError('Body stream must yield Uint8Array chunks');
        total += item.value.byteLength;
        if (total > maxBodyBytes) throw new RangeError('Body exceeds configured byte limit');
        for (let offset = 0; offset < item.value.byteLength; offset += CHUNK_SIZE) yield item.value.subarray(offset, offset + CHUNK_SIZE);
      }
    } catch (error) { reader.cancel(error).catch(() => {}); throw error; }
    finally {
      if (!complete) reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function consume(object) {
    const parts = [];
    let length = 0;
    for await (const chunk of chunks(object)) { parts.push(chunk); length += chunk.byteLength; }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
    return output;
  }
  class Body {
    get body() { return state(this).body; }
    get bodyUsed() { return disturbed(state(this)); }
    async arrayBuffer() { return (await consume(this)).buffer; }
    async bytes() { return consume(this); }
    async text() { return new TextDecoder().decode(await consume(this)); }
    textStream() {
      const current = state(this);
      usable(current);
      if (!current.body) return new ReadableStream({ start(controller) { controller.close(); } });
      current.used = true;
      return current.body.pipeThrough(new primitives.TextDecoderStream());
    }
    async json() { return JSON.parse(await this.text()); }
    async blob() { return new Blob([await consume(this)], { type: this.headers.get('content-type') ?? '' }); }
    async formData() {
      const id = nextId++;
      await bridge('fetch.formStart', id, this.headers.get('content-type') ?? '');
      try {
        for await (const chunk of chunks(this)) await bridge('fetch.formWrite', id, chunk);
        const descriptions = await bridge('fetch.formFinish', id);
        const output = new FormData();
        for (let index = 0; index < descriptions.length; index++) {
          const description = descriptions[index];
          const parts = [];
          for (let offset = 0; offset < description.size; offset += CHUNK_SIZE) parts.push(await bridge('fetch.formRead', id, index, offset));
          if (description.file) output.append(description.name, new File(parts, description.filename, { type: description.type, lastModified: description.lastModified }));
          else output.append(description.name, await new Blob(parts).text());
        }
        return output;
      } finally { await bridge('fetch.formClose', id); }
    }
  }
  function enumValue(value, choices, label) {
    value = String(value);
    if (!choices.includes(value)) throw new TypeError(`Invalid ${label}: ${value}`);
    return value;
  }
  function cloneBody(current) {
    usable(current);
    if (!current.body) return null;
    const [left, right] = current.body.tee();
    current.body = left;
    return right;
  }
  const optionDefaults = { method: 'GET', mode: 'cors', credentials: 'same-origin', cache: 'default', redirect: 'follow', referrer: 'about:client', referrerPolicy: '', integrity: '', keepalive: false, duplex: 'half', priority: 'auto' };
  const enums = {
    mode: ['cors', 'no-cors', 'same-origin'], credentials: ['omit', 'same-origin', 'include'],
    cache: ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'],
    redirect: ['follow', 'error', 'manual'], duplex: ['half'], priority: ['high', 'low', 'auto'],
    referrerPolicy: ['', 'no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url'],
  };
  class Request extends Body {
    constructor(input, init = {}) {
      super();
      if (input === undefined) throw new TypeError('Request needs a URL');
      init ??= {};
      if (typeof init !== 'object' && typeof init !== 'function') throw new TypeError('Expected request options');
      const inherited = input instanceof Request ? state(input) : null;
      const url = new URL(inherited ? inherited.url : String(input));
      if (url.username || url.password) throw new TypeError('Request URL contains credentials');
      const options = { ...(inherited?.options ?? optionDefaults) };
      for (const key of Object.keys(optionDefaults)) if (init[key] !== undefined) {
        options[key] = enums[key] ? enumValue(init[key], enums[key], key) : key === 'keepalive' ? Boolean(init[key]) : String(init[key]);
      }
      let method = byteString(options.method);
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method) || ['CONNECT', 'TRACE', 'TRACK'].includes(method.toUpperCase())) throw new TypeError('Invalid request method');
      if (['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'].includes(method.toUpperCase())) method = method.toUpperCase();
      options.method = method;
      if (options.cache === 'only-if-cached' && options.mode !== 'same-origin') throw new TypeError('only-if-cached requires same-origin mode');
      if (options.mode === 'no-cors' && !['GET', 'HEAD', 'POST'].includes(method)) throw new TypeError('Invalid method for no-cors mode');
      if (init.window !== undefined && init.window !== null) throw new TypeError('window must be null');
      if (options.referrer !== '' && options.referrer !== 'about:client') options.referrer = new URL(options.referrer).href;
      const headers = new Headers(init.headers === undefined ? inherited?.headers : init.headers);
      const signal = init.signal === undefined ? inherited?.signal : init.signal;
      if (signal != null && !(signal instanceof AbortSignal)) throw new TypeError('Expected AbortSignal');
      if ((init.body != null || inherited?.body) && ['GET', 'HEAD'].includes(method)) throw new TypeError('GET and HEAD cannot have bodies');
      let content;
      if (init.body != null) content = extract(init.body);
      else if (inherited?.body) {
        usable(inherited);
        content = { body: inherited.body.pipeThrough(new TransformStream()), replayable: inherited.replayable, type: null, used: false };
        inherited.used = true;
      } else content = extract(null);
      if (content.body && !content.replayable && init.body != null && init.duplex !== 'half') throw new TypeError('Streaming request bodies require duplex: half');
      if (content.body && !content.replayable && options.keepalive) throw new TypeError('Streaming bodies cannot use keepalive');
      if (content.type && !headers.has('content-type')) headers.set('content-type', content.type);
      bodies.set(this, { ...content, kind: 'request', url: url.href, options, headers, signal: signal ? AbortSignal.any([signal]) : new AbortController().signal });
    }
    get url() { return state(this).url; }
    get headers() { return state(this).headers; }
    get signal() { return state(this).signal; }
    get destination() { state(this); return ''; }
    get isReloadNavigation() { state(this); return false; }
    get isHistoryNavigation() { state(this); return false; }
    clone() {
      const original = state(this);
      const body = cloneBody(original);
      const clone = Object.create(Request.prototype);
      bodies.set(clone, { ...original, body, used: false, headers: new Headers(original.headers), options: { ...original.options }, signal: AbortSignal.any([original.signal]) });
      return clone;
    }
    get [Symbol.toStringTag]() { return 'Request'; }
  }
  for (const property of Object.keys(optionDefaults)) Object.defineProperty(Request.prototype, property, { configurable: true, enumerable: true, get() { return state(this).options[property]; } });
  class Response extends Body {
    constructor(body = null, init = {}) {
      super();
      init ??= {};
      if (typeof init !== 'object' && typeof init !== 'function') throw new TypeError('Expected response options');
      const status = init.status === undefined ? 200 : Number(init.status);
      if (!Number.isInteger(status) || status < 200 || status > 599) throw new RangeError('Response status must be 200 through 599');
      const statusText = byteString(init.statusText ?? '');
      if (/[^\t\x20-\x7e\x80-\xff]/.test(statusText)) throw new TypeError('Invalid response status text');
      const content = extract(body);
      if (content.body && [204, 205, 304].includes(status)) throw new TypeError('This status cannot have a response body');
      const headers = new Headers(init.headers);
      if (content.type && !headers.has('content-type')) headers.set('content-type', content.type);
      bodies.set(this, { ...content, kind: 'response', status, statusText, headers, url: '', redirected: false, type: 'default' });
    }
    get headers() { return state(this).headers; }
    get status() { return state(this).status; }
    get statusText() { return state(this).statusText; }
    get ok() { return this.status >= 200 && this.status <= 299; }
    get url() { return state(this).url; }
    get redirected() { return state(this).redirected; }
    get type() { return state(this).type; }
    clone() {
      const original = state(this);
      const body = cloneBody(original);
      const clone = Object.create(Response.prototype);
      const headers = new Headers(original.headers);
      headersState.get(headers).immutable = headersState.get(original.headers).immutable;
      bodies.set(clone, { ...original, body, used: false, headers });
      return clone;
    }
    static error() {
      const response = new Response();
      Object.assign(state(response), { status: 0, type: 'error' });
      headersState.get(response.headers).immutable = true;
      return response;
    }
    static redirect(url, status = 302) {
      status = Number(status);
      if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status');
      const response = new Response(null, { status, headers: { location: new URL(String(url)).href } });
      headersState.get(response.headers).immutable = true;
      return response;
    }
    static json(data, init = {}) {
      const encoded = JSON.stringify(data);
      if (encoded === undefined) throw new TypeError('Value cannot be serialized as JSON');
      const headers = new Headers(init?.headers);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      return new Response(encoded, { ...init, headers });
    }
    get [Symbol.toStringTag]() { return 'Response'; }
  }
  function networkError(description) {
    if (['AbortError', 'TimeoutError'].includes(description?.name)) return new DOMException(description.message, description.name);
    const error = new (description?.name === 'RangeError' ? RangeError : TypeError)(description?.message ?? 'Fetch failed');
    return error;
  }
  function finish(entry, reason) {
    requests.delete(entry.id);
    entry.uploadCancelled = true;
    entry.request.signal.removeEventListener('abort', entry.abort);
    primitives.releaseSignal(entry.request.signal);
    entry.uploadReader?.cancel(reason).catch(() => {});
    entry.upload?.return?.().catch(() => {});
  }
  function fail(entry, error, cancelHost = true) {
    if (!requests.has(entry.id)) return;
    finish(entry, error);
    entry.reject(error);
    try { entry.controller?.error(error); } catch { /* Stream may already be closed. */ }
    entry.pullReject?.(error);
    if (cancelHost) bridge('fetch.cancel', entry.id).catch(() => {});
  }
  async function pumpUpload(entry) {
    if (entry.uploading) return;
    entry.uploading = true;
    try {
      while (entry.uploadDemand > 0 && requests.has(entry.id) && !entry.uploadCancelled) {
        entry.uploadDemand--;
        const item = await entry.upload.next();
        if (!requests.has(entry.id) || entry.uploadCancelled) return;
        await bridge('fetch.upload', entry.id, item.done ? null : item.value, item.done);
        if (item.done) { entry.upload = null; break; }
      }
    } catch (error) { fail(entry, error); }
    finally { entry.uploading = false; }
  }
  async function fetch(input, init) {
    if (disposed) throw new TypeError('Fetch capability was disposed');
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const current = state(request);
    const blobURL = new URL(request.url).protocol === 'blob:';
    const blob = blobURL ? primitives.resolveBlobURL(request.url) : null;
    if (blobURL && (!blob || request.method !== 'GET')) throw new TypeError('Blob URL is unavailable or method is not GET');
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const entry = { id, request, resolve, reject, upload: null, uploadDemand: 0, uploading: false };
      if (current.body || blob) entry.upload = chunks(blob ? new Response(blob) : request, reader => { entry.uploadReader = reader; })[Symbol.asyncIterator]();
      entry.abort = () => fail(entry, request.signal.reason);
      requests.set(id, entry);
      request.signal.addEventListener('abort', entry.abort, { once: true });
      bridge('fetch.start', id, { url: request.url, headers: [...request.headers], options: current.options, body: Boolean(current.body || blob), replayable: blob ? true : current.replayable, blob: blob ? { type: blob.type } : null }).catch(error => fail(entry, error));
    });
  }
  function dispatch(type, payload) {
    const entry = requests.get(payload.id);
    if (!entry) return;
    if (type === 'fetch.uploadPull') { entry.uploadDemand++; void pumpUpload(entry); return; }
    if (type === 'fetch.uploadCancel') { entry.uploadCancelled = true; entry.uploadReader?.cancel(networkError(payload.error)).catch(() => {}); entry.upload?.return?.().catch(() => {}); entry.upload = null; return; }
    if (type === 'fetch.error') { fail(entry, networkError(payload.error), false); return; }
    if (type === 'fetch.response') {
      const response = Object.create(Response.prototype);
      const headers = new Headers(payload.headers);
      headersState.get(headers).immutable = true;
      const body = payload.body ? new ReadableStream({
        type: 'bytes',
        start(controller) { entry.controller = controller; },
        pull() {
          return new Promise((resolve, reject) => {
            entry.pullResolve = resolve;
            entry.pullReject = reject;
            bridge('fetch.read', entry.id).catch(error => fail(entry, error));
          });
        },
        cancel(reason) { finish(entry, reason); return bridge('fetch.cancel', entry.id); },
      }, { highWaterMark: 0 }) : null;
      bodies.set(response, { kind: 'response', body, used: false, replayable: false, headers, status: payload.status, statusText: payload.statusText, url: payload.url, redirected: payload.redirected, type: payload.type });
      entry.resolve(response);
      if (!body) finish(entry);
      return;
    }
    if (type === 'fetch.chunk') {
      if (payload.done) {
        entry.controller.close();
        entry.controller.byobRequest?.respond(0);
        finish(entry);
      } else entry.controller.enqueue(payload.bytes);
      entry.pullResolve?.();
      entry.pullResolve = entry.pullReject = null;
    }
  }
  return {
    fetch, Request, Response, Headers, dispatch,
    dispose() {
      disposed = true;
      for (const entry of requests.values()) fail(entry, new DOMException('Fetch capability was disposed', 'AbortError'));
    },
  };
}
