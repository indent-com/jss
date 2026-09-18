// Node owns sockets and HTTP parsing. No host object is passed into QuickJS.
// Fetch algorithms: https://fetch.spec.whatwg.org/#http-redirect-fetch
import { createHash, timingSafeEqual } from 'node:crypto';

const CHUNK_SIZE = 64 * 1024;
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length'];
const REFERRER_POLICIES = new Set(['no-referrer', 'no-referrer-when-downgrade', 'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url']);

export function createFetchHost({
  emit, allowedOrigins = [], maxBodyBytes = 8 * 1024 * 1024,
  maxActive = 32, timeoutMs = 30_000, fetch: nativeFetch = globalThis.fetch,
} = {}) {
  if (typeof emit !== 'function') throw new TypeError('Fetch needs an event emitter');
  for (const [name, value] of Object.entries({ maxBodyBytes, maxActive, timeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${name}`);
  }
  const allowed = new Set(allowedOrigins.map(origin => new URL(origin).origin));
  const requests = new Map();
  const forms = new Map();
  let disposed = false;
  const errorData = error => ({ name: error?.name || 'Error', message: String(error?.message ?? error) });
  const validId = id => {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('Invalid fetch resource identifier');
  };
  function assertAvailable(id) {
    validId(id);
    if (disposed) throw new Error('Fetch capability was disposed');
    if (requests.has(id) || forms.has(id)) throw new TypeError('Duplicate fetch resource identifier');
    if (requests.size + forms.size >= maxActive) throw new RangeError('Too many active fetch resources');
  }
  function permitted(input) {
    const url = new URL(input);
    if (url.protocol === 'data:') return url;
    if (!['http:', 'https:'].includes(url.protocol) || !allowed.has(url.origin)) {
      throw new TypeError(`Fetch origin is not allowed: ${url.origin}`);
    }
    if (url.username || url.password) throw new TypeError('Fetch URLs cannot contain credentials');
    return url;
  }
  function bytes(value) {
    if (!(value instanceof Uint8Array) || value.byteLength > CHUNK_SIZE) throw new TypeError('Expected a byte chunk of at most 64 KiB');
    return new Uint8Array(value);
  }
  function release(state, reason) {
    if (!requests.delete(state.id)) return;
    clearTimeout(state.timer);
    state.controller.abort(reason ?? new DOMException('The operation was aborted', 'AbortError'));
    state.reader?.cancel(reason).catch(() => {});
    try { state.uploadController?.error(reason); } catch { /* Upload may already be closed. */ }
    state.uploadWait?.();
    state.uploadWait = null;
    state.uploadChunks = [];
  }
  async function send(type, payload, state) {
    try { await emit(type, payload); }
    catch (error) {
      if (state) {
        release(state, error);
        try { await emit('fetch.error', { id: state.id, error: errorData(error) }); }
        catch { /* The enclosing runner owns cleanup if delivery is unavailable. */ }
      }
    }
  }
  async function fail(state, error) {
    if (!requests.has(state.id)) return;
    release(state, error);
    await send('fetch.error', { id: state.id, error: errorData(error) });
  }
  async function follow(state, body) {
    let url = permitted(state.init.url);
    let init = { ...state.init.options, headers: new Headers(state.init.headers), body, signal: state.controller.signal };
    const redirect = init.redirect ?? 'follow';
    let redirected = false;
    for (let count = 0; ; count++) {
      const response = await nativeFetch(url, {
        ...init, redirect: 'manual', ...(redirect === 'follow' ? { integrity: '' } : {}),
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      });
      if (![301, 302, 303, 307, 308].includes(response.status) || redirect === 'manual') return { response, redirected };
      const location = response.headers.get('location');
      if (location === null) return { response, redirected };
      if (redirect === 'error') { response.body?.cancel().catch(() => {}); throw new TypeError('Fetch redirect mode is error'); }
      if (count >= 20) { response.body?.cancel().catch(() => {}); throw new TypeError('Too many fetch redirects'); }
      let next;
      try {
        next = permitted(new URL(location, url));
        if (!['http:', 'https:'].includes(next.protocol)) throw new TypeError('HTTP redirects must target HTTP(S) URLs');
        if (!location.includes('#')) next.hash = url.hash;
      } finally { response.body?.cancel().catch(() => {}); }
      if (([301, 302].includes(response.status) && init.method === 'POST') || (response.status === 303 && !['GET', 'HEAD'].includes(init.method))) {
        init.method = 'GET';
        body = null;
        init.body = null;
        for (const header of BODY_HEADERS) init.headers.delete(header);
      } else if (body instanceof ReadableStream) {
        throw new TypeError('A streaming upload cannot be replayed across this redirect');
      }
      if (url.origin !== next.origin) {
        for (const header of ['authorization', 'proxy-authorization', 'cookie', 'host']) init.headers.delete(header);
      }
      for (const policy of (response.headers.get('referrer-policy') ?? '').split(/\s*,\s*/)) {
        if (REFERRER_POLICIES.has(policy)) init.referrerPolicy = policy;
      }
      url = next;
      redirected = true;
    }
  }
  async function verifyIntegrity(state, response) {
    const candidates = String(state.init.options.integrity ?? '').split(/\s+/)
      .map(token => /^(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(?:\?.*)?$/.exec(token)).filter(Boolean);
    if (!candidates.length) return undefined;
    const algorithm = candidates.map(candidate => candidate[1]).sort().at(-1);
    const expected = candidates.filter(candidate => candidate[1] === algorithm).map(candidate => Buffer.from(candidate[2], 'base64'));
    const hash = createHash(algorithm);
    const parts = [];
    let length = 0;
    if (response.body) {
      state.reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await state.reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxBodyBytes) throw new RangeError('Fetch response exceeds configured byte limit');
          hash.update(value);
          parts.push(value);
        }
      } finally { state.reader.releaseLock(); state.reader = null; }
    }
    const actual = hash.digest();
    if (!expected.some(value => value.byteLength === actual.byteLength && timingSafeEqual(value, actual))) throw new TypeError('Fetch integrity mismatch');
    return response.body ? new Blob(parts).stream() : null;
  }
  async function startNetwork(state, body) {
    try {
      let response;
      let redirected = false;
      if (state.init.blob) {
        const localURL = URL.createObjectURL(new Blob([body], { type: state.init.blob.type }));
        try { response = await nativeFetch(localURL, { ...state.init.options, headers: state.init.headers, signal: state.controller.signal }); }
        finally { URL.revokeObjectURL(localURL); }
      } else ({ response, redirected } = await follow(state, body));
      if (!requests.has(state.id)) { response.body?.cancel().catch(() => {}); return; }
      const verifiedBody = !state.init.blob && (state.init.options.redirect ?? 'follow') === 'follow'
        ? await verifyIntegrity(state, response) : undefined;
      if (!requests.has(state.id)) { verifiedBody?.cancel().catch(() => {}); return; }
      state.reader = (verifiedBody === undefined ? response.body : verifiedBody)?.getReader() ?? null;
      let responseURL = state.init.blob ? state.init.url : response.url;
      if (responseURL) { const normalized = new URL(responseURL); normalized.hash = ''; responseURL = normalized.href; }
      await send('fetch.response', {
        id: state.id, status: response.status, statusText: response.statusText,
        headers: [...response.headers], url: responseURL, redirected,
        type: response.type, body: Boolean(state.reader),
      }, state);
      if (!state.reader) release(state);
    } catch (error) { await fail(state, error); }
  }
  function request(id) {
    validId(id);
    const state = requests.get(id);
    if (!state) throw new TypeError('Fetch resource is closed');
    return state;
  }
  function form(id) {
    validId(id);
    const state = forms.get(id);
    if (!state) throw new TypeError('FormData resource is closed');
    return state;
  }
  const handlers = {
    'fetch.start'(id, init) {
      assertAvailable(id);
      if (init.blob) {
        if (!String(init.url).startsWith('blob:jss/') || init.options.method !== 'GET') throw new TypeError('Invalid Blob URL request');
      } else permitted(init.url);
      const state = { id, init, controller: new AbortController(), uploadChunks: [], uploadBytes: 0, downloadBytes: 0, reading: false, remainder: null, uploadWait: null, uploadController: null };
      state.timer = setTimeout(() => { void fail(state, new DOMException('Fetch resource timed out', 'TimeoutError')); }, timeoutMs);
      state.timer.unref?.();
      requests.set(id, state);
      if (!init.body) { void startNetwork(state, null); return; }
      if (init.replayable) { void send('fetch.uploadPull', { id }, state); return; }
      const upload = new ReadableStream({
        start(controller) { state.uploadController = controller; },
        pull() {
          return new Promise(resolve => {
            state.uploadWait = resolve;
            void send('fetch.uploadPull', { id }, state);
          });
        },
        cancel(reason) { void send('fetch.uploadCancel', { id, error: errorData(reason) }, state); },
      }, { highWaterMark: 0 });
      void startNetwork(state, upload);
    },
    'fetch.upload'(id, chunk, done) {
      const state = request(id);
      if (done) {
        if (state.init.replayable) {
          const body = new Uint8Array(state.uploadBytes);
          let offset = 0;
          for (const part of state.uploadChunks) { body.set(part, offset); offset += part.byteLength; }
          state.uploadChunks = [];
          void startNetwork(state, body);
        } else state.uploadController.close();
      } else {
        chunk = bytes(chunk);
        state.uploadBytes += chunk.byteLength;
        if (state.uploadBytes > maxBodyBytes) { void fail(state, new RangeError('Fetch upload exceeds configured byte limit')); return; }
        if (state.init.replayable) {
          state.uploadChunks.push(chunk);
          void send('fetch.uploadPull', { id }, state);
        } else state.uploadController.enqueue(chunk);
      }
      state.uploadWait?.();
      state.uploadWait = null;
    },
    'fetch.read'(id) {
      const state = request(id);
      if (state.reading || !state.reader) throw new TypeError('Invalid response read');
      state.reading = true;
      void (async () => {
        try {
          let chunk = state.remainder;
          if (!chunk) {
            const item = await state.reader.read();
            if (!requests.has(id)) return;
            if (item.done) {
              await send('fetch.chunk', { id, done: true }, state);
              release(state);
              return;
            }
            chunk = item.value;
            state.downloadBytes += chunk.byteLength;
            if (state.downloadBytes > maxBodyBytes) throw new RangeError('Fetch response exceeds configured byte limit');
          }
          state.remainder = chunk.byteLength > CHUNK_SIZE ? chunk.subarray(CHUNK_SIZE) : null;
          state.reading = false;
          await send('fetch.chunk', { id, done: false, bytes: new Uint8Array(chunk.subarray(0, CHUNK_SIZE)) }, state);
        } catch (error) { await fail(state, error); }
      })();
    },
    'fetch.cancel'(id) { const state = requests.get(id); if (state) release(state); },
    'fetch.formStart'(id, contentType) {
      assertAvailable(id);
      const state = { chunks: [], length: 0, contentType: String(contentType), fields: null };
      state.timer = setTimeout(() => { forms.delete(id); }, timeoutMs);
      state.timer.unref?.();
      forms.set(id, state);
    },
    'fetch.formWrite'(id, chunk) {
      const state = form(id);
      if (state.fields) throw new TypeError('FormData has already been parsed');
      chunk = bytes(chunk);
      state.length += chunk.byteLength;
      if (state.length > maxBodyBytes) throw new RangeError('FormData exceeds configured byte limit');
      state.chunks.push(chunk);
    },
    async 'fetch.formFinish'(id) {
      const state = form(id);
      const data = await new Response(new Blob(state.chunks), { headers: { 'content-type': state.contentType } }).formData();
      state.chunks = [];
      state.fields = [];
      let outputBytes = 0;
      let metadataChars = 0;
      for (const [name, value] of data) {
        if (state.fields.length >= 1024) throw new RangeError('Too many FormData fields');
        metadataChars += name.length + (typeof value === 'string' ? 0 : value.name.length + value.type.length);
        if (metadataChars > 128 * 1024) throw new RangeError('FormData field metadata exceeds configured limit');
        if (typeof value === 'string') {
          const encoded = new TextEncoder().encode(value);
          outputBytes += encoded.byteLength;
          state.fields.push({ name, value: encoded, size: encoded.byteLength, file: false });
        } else {
          outputBytes += value.size;
          state.fields.push({ name, value, size: value.size, file: true, filename: value.name, type: value.type, lastModified: value.lastModified });
        }
        if (outputBytes > maxBodyBytes) throw new RangeError('Decoded FormData exceeds configured byte limit');
      }
      return state.fields.map(({ value, ...description }) => description);
    },
    async 'fetch.formRead'(id, index, offset) {
      const field = form(id).fields?.[index];
      if (!field || !Number.isSafeInteger(offset) || offset < 0 || offset > field.size) throw new TypeError('Invalid FormData read');
      return field.file ? new Uint8Array(await field.value.slice(offset, offset + CHUNK_SIZE).arrayBuffer()) : field.value.slice(offset, offset + CHUNK_SIZE);
    },
    'fetch.formClose'(id) { const state = forms.get(id); if (state) clearTimeout(state.timer); forms.delete(id); },
  };
  return {
    handlers,
    dispose() {
      disposed = true;
      for (const state of requests.values()) release(state);
      for (const state of forms.values()) clearTimeout(state.timer);
      forms.clear();
    },
  };
}
