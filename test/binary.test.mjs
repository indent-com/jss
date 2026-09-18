import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { Engine } from '../dist/engine.js';
import { loadWasm } from '../dist/node-assets.js';
import { createSandbox } from '../dist/node.js';
import * as codec from '../dist/codec.js';

const cloneError = error => error.code === 'ERR_CLONE';
const pattern = length => Uint8Array.from({ length }, (_, i) => (i * 71 + 19) & 255);
const raw = value => value instanceof ArrayBuffer ? new Uint8Array(value)
  : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

function checkCodec(implementation) {
  for (const length of [0, 1, 2, 3, 4, 255, 4095, 4096, 16_384, 65_535, 65_536, 65_537]) {
    const bytes = pattern(length), wire = implementation.encode(bytes);
    assert.deepEqual(wire, ['bytes', 'Uint8Array', bytes]);
    assert.notEqual(wire[2].buffer, bytes.buffer);
    const copy = implementation.decode(wire);
    assert.notEqual(copy.buffer, wire[2].buffer);
    assert.deepEqual(copy, bytes);
    assert.equal(copy.constructor, Uint8Array);
    assert.equal(copy.byteOffset, 0);
    assert.equal(copy.buffer.byteLength, bytes.byteLength);
    assert.notEqual(copy.buffer, bytes.buffer);
  }
  for (const Type of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array]) {
    const backing = pattern(96), value = new Type(backing.buffer, 16, 64 / Type.BYTES_PER_ELEMENT);
    const copied = implementation.decode(implementation.encode(value));
    assert.equal(copied.constructor, Type);
    assert.equal(copied.byteOffset, 0);
    assert.equal(copied.buffer.byteLength, value.byteLength);
    assert.deepEqual(raw(copied), raw(value));
  }
  const backing = pattern(123);
  for (const value of [backing.buffer, new DataView(backing.buffer, 7, 39), Buffer.from(backing).subarray(5, 90)]) {
    const copied = implementation.decode(implementation.encode(value));
    assert.deepEqual(raw(copied), raw(value));
    assert.notEqual(copied instanceof ArrayBuffer ? copied : copied.buffer, backing.buffer);
    assert.equal(copied instanceof ArrayBuffer ? copied.byteLength : copied.buffer.byteLength, value.byteLength);
  }
  for (const invalid of ['AQ==', null, 0, {}, { $jssBytes: 0 }, new ArrayBuffer(0), new Int8Array(1)]) {
    assert.throws(() => implementation.decode(['bytes', 'Uint8Array', invalid]), cloneError);
  }
  assert.throws(() => implementation.decode(['bytes', 'UnknownArray', new Uint8Array(0)]), cloneError);
  assert.throws(() => implementation.decode(['bytes', 'Int32Array', new Uint8Array(1)]), cloneError);
}

test('binary codec snapshots raw bytes and preserves supported views without pooled memory', () => {
  checkCodec(codec);
  const original = Buffer.from([7, 19, 37]).subarray(1, 2);
  const encoded = codec.encode(original);
  original[0] = 255;
  const first = codec.decode(encoded), second = codec.decode(encoded);
  assert.notEqual(first.buffer, second.buffer);
  first[0] = 0;
  assert.equal(second[0], 19);
  const detached = new Uint8Array([1, 2]);
  structuredClone(detached, { transfer: [detached.buffer] });
  assert.throws(() => codec.encode(detached), cloneError);
});

test('binary limits count decoded bytes and binary metadata never invokes user accessors', () => {
  const bytes = pattern(257);
  for (const property of ['constructor', 'buffer', 'byteOffset', 'byteLength']) {
    Object.defineProperty(bytes, property, { get() { throw Error(`Unexpected ${property} getter`); } });
  }
  assert.deepEqual(codec.decode(codec.encode(bytes)), pattern(257));
  assert.throws(() => codec.encode(new Uint8Array(16 * 1024 * 1024)), cloneError);
  const tooLarge = new Uint8Array(16 * 1024 * 1024);
  assert.throws(() => codec.decode(['bytes', 'Uint8Array', tooLarge]), cloneError);
  if (typeof SharedArrayBuffer === 'function') {
    assert.throws(() => codec.encode(new Uint8Array(new SharedArrayBuffer(4))), cloneError);
  }
});

for (const execution of ['inline', 'worker']) {
  test(`${execution}: binary attachment callbacks copy visible bytes independently`, { timeout: 20_000 }, async () => {
    await using sandbox = await createSandbox({ execution, timeoutMs: 5_000 });
    await sandbox.expose('copyBinary', async bytes => new Uint8Array(bytes));
    const value = pattern(65_543).subarray(3, 65_539);
    await sandbox.set('binary', value);
    const copy = await sandbox.evaluate('await copyBinary(binary)');
    assert.deepEqual(copy, value);
    copy[0] ^= 255;
    assert.equal(await sandbox.evaluate('binary[0]'), value[0]);
    for (const size of [0, 1, 2, 3]) {
      assert.deepEqual(await sandbox.evaluate(`await copyBinary(new Uint8Array(${size}).fill(255))`), new Uint8Array(size).fill(255));
    }
    for (const Type of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
      Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView]) {
      const backing = pattern(96);
      const view = Type === DataView ? new DataView(backing.buffer, 16, 64)
        : new Type(backing.buffer, 16, 64 / Type.BYTES_PER_ELEMENT);
      await sandbox.set('view', view);
      const result = await sandbox.get('view');
      assert.equal(result.constructor, Type);
      assert.equal(result.byteOffset, 0);
      assert.equal(result.buffer.byteLength, 64);
      assert.deepEqual(raw(result), raw(view));
    }
    await assert.rejects(sandbox.evaluate('new Uint8Array(new SharedArrayBuffer(4))'), cloneError);
  });

  test(`${execution}: binary attachment paths survive poisoned guest base64 methods and prototypes`, { timeout: 20_000 }, async () => {
    await using sandbox = await createSandbox({ execution, timeoutMs: 5_000 });
    await sandbox.evaluate(`
      globalThis.binary = new Uint8Array([0, 1, 2, 253, 254, 255]);
      const broken = () => { throw Error('poisoned intrinsic'); };
      const desc = Object.create(null);
      desc.get = broken; desc.configurable = true;
      Object.defineProperty(Object.prototype, 'alphabet', desc);
      Object.defineProperty(Object.prototype, 'lastChunkHandling', desc);
      Object.defineProperty(String.prototype, '-1', desc);
      Object.defineProperty(String.prototype, '-2', desc);
      const numeric = Object.create(null);
      numeric.set = broken; numeric.configurable = true;
      Object.defineProperty(Array.prototype, '0', numeric);
      Uint8Array.prototype.toBase64 = broken;
      Uint8Array.prototype.setFromBase64 = broken;
      Uint8Array.fromBase64 = broken;
      Uint8Array.prototype.set = broken;
      ArrayBuffer.prototype.slice = broken;
      WeakSet.prototype.add = broken;
      WeakSet.prototype.has = broken;
      Object.prototype.toJSON = broken;
      globalThis.Uint8Array = broken;
      globalThis.ArrayBuffer = broken;
      undefined
    `);
    assert.deepEqual(await sandbox.get('binary'), new Uint8Array([0, 1, 2, 253, 254, 255]));
    await sandbox.set('fromHost', pattern(65_536));
    assert.deepEqual(await sandbox.get('fromHost'), pattern(65_536));
    await sandbox.set('empty', new Uint8Array(0));
    assert.deepEqual(await sandbox.get('empty'), new Uint8Array(0));
  });

  test(`${execution}: binary attachment markers cannot be forged by user records or arrays`, { timeout: 20_000 }, async () => {
    await using sandbox = await createSandbox({ execution, timeoutMs: 5_000 });
    await sandbox.expose('copyBinaryRecord', async value => value);
    const malicious = '\"}]],\"injected\":true,\"value\":\"\\\n\r\t\u0000\u2028\u2029\ud800';
    const value = { real: pattern(257), lookalike: ['bytes', 'Uint8Array', malicious], marker: { $jssBytes: 0 }, nested: [{ $jssBytes: 123 }] };
    await sandbox.set('record', value);
    assert.deepEqual(await sandbox.evaluate('record'), value);
    assert.deepEqual(await sandbox.evaluate('await copyBinaryRecord(record)'), value);
    // keys() returns an unencoded string array directly to the renderer.
    const keys = ['bytes', 'Uint8Array', malicious];
    await using handle = await sandbox.handle(Object.fromEntries(keys.map(key => [key, 1])));
    assert.deepEqual(await handle.keys(), keys);
  });

  test(`${execution}: binary snapshots precede later argument traps and host mutations`, { timeout: 20_000 }, async () => {
    await using sandbox = await createSandbox({ execution, timeoutMs: 5_000 });
    await sandbox.expose('snapshot', value => value);
    assert.deepEqual(await sandbox.evaluate(`
      const bytes = new Uint8Array([1, 2, 3]);
      const later = new Proxy({}, { ownKeys() { bytes[0] = 99; return []; } });
      const answer = snapshot(bytes, later);
      bytes[1] = 88;
      await answer
    `), new Uint8Array([1, 2, 3]));
    await sandbox.evaluate('globalThis.identity = value => value; undefined');
    const input = pattern(65_536), expected = input.slice();
    const pending = sandbox.call('identity', [input]);
    input.fill(255);
    assert.deepEqual(await pending, expected);
    assert.equal(input.buffer.byteLength, 65_536);
    const repeated = await sandbox.call('identity', [{ a: expected, b: expected }]);
    repeated.a[0] ^= 255;
    assert.equal(repeated.b[0], expected[0]);
    assert.notEqual(repeated.a.buffer, repeated.b.buffer);
  });

  test(`${execution}: attachments survive memory growth and release snapshots after failures`, { timeout: 20_000 }, async () => {
    await using sandbox = await createSandbox({ execution, timeoutMs: 5_000, memoryLimitBytes: 48 * 1024 * 1024 });
    await sandbox.expose('copyBytes', value => value);
    await sandbox.evaluate('globalThis.growth = new Uint8Array(24 * 1024 * 1024); undefined');
    const bytes = pattern(1024 * 1024);
    await sandbox.set('large', bytes);
    for (let i = 0; i < 24; i++) {
      assert.deepEqual(await sandbox.evaluate('await copyBytes(large)'), bytes);
      assert.equal(await sandbox.evaluate(`
        try { await copyBytes(large, () => {}); false }
        catch (error) { error.code === 'ERR_CLONE' }
      `), true);
    }
    assert.equal(await sandbox.evaluate('large[1024]'), bytes[1024]);
  });

  test(`${execution}: direct global calls preserve receiver, getter behavior and UTF-16 names`, async () => {
    await using sandbox = await createSandbox({ execution });
    const name = 'method\0\ud800';
    await sandbox.set('methodName', name);
    await sandbox.evaluate(`
      globalThis.getterCount = 0;
      Object.defineProperty(globalThis, methodName, { get() {
        getterCount++; return function (value) { return [this === globalThis, value, getterCount]; };
      } });
      Object.defineProperty(globalThis, 'badMethod', { get() { throw Error('getter failure'); } });
      undefined
    `);
    assert.deepEqual(await sandbox.call(name, [42]), [true, 42, 1]);
    await assert.rejects(sandbox.call('badMethod'), /getter failure/);
    assert.deepEqual(await sandbox.call(name, [43]), [true, 43, 2]);
  });
}

test('worker transfer lists detach only library-owned byte snapshots', async () => {
  await using worker = new Worker(new URL('../dist/node-worker.js', import.meta.url), { execArgv: [] });
  const post = worker.postMessage.bind(worker), caller = pattern(65_536);
  let transfers = 0;
  worker.postMessage = (message, list) => {
    for (const buffer of list ?? []) {
      assert.notEqual(buffer, caller.buffer);
      assert.equal(buffer.byteLength, caller.byteLength);
      transfers++;
    }
    post(message, list);
    for (const buffer of list ?? []) assert.equal(buffer.byteLength, 0);
  };
  await using sandbox = await createSandbox({ workerFactory: () => worker });
  await sandbox.expose('echoBytes', value => value);
  await sandbox.evaluate('globalThis.roundTrip = value => echoBytes(value); undefined');
  assert.deepEqual(await sandbox.call('roundTrip', [caller]), caller);
  assert.equal(caller.buffer.byteLength, 65_536);
  assert.equal(transfers, 2);
});

test('native binary imports reject missing indices and misaligned views without retiring the engine', async () => {
  using resources = new DisposableStack();
  const engine = resources.adopt(await Engine.create({ memoryLimitBytes: 16 * 1024 * 1024, stackLimitBytes: 512 * 1024,
    timeoutMs: 5_000, wasmBinary: await loadWasm() }, {
    hostCall() { assert.fail('unexpected callback'); }, onUnhandled() {}, onFatal() { assert.fail('unexpected fatal error'); },
  }), value => value.dispose());
  for (const reference of [-1, 0, 1.5, 999999]) {
    await assert.rejects(engine.execute({ op: 'make', args: [{ value: ['bytes', 'Uint8Array', { $jssBytes: reference }] }] }, 5_000), /binary attachment/);
  }
  await assert.rejects(engine.execute({ op: 'make', args: [{ value: ['bytes', 'Int32Array', new Uint8Array(1)] }] }, 5_000), cloneError);
  const huge = new Uint8Array(16 * 1024 * 1024);
  await assert.rejects(engine.execute({ op: 'make', args: [huge, huge, huge, huge, huge] }, 5_000), error => error.code === 'ERR_RESOURCE_LIMIT');
  const id = await engine.execute({ op: 'make', args: [{ value: codec.encode(pattern(257)) }] }, 5_000);
  assert.deepEqual(codec.decode(await engine.execute({ op: 'dump', args: [id] }, 5_000)), pattern(257));
  await engine.execute({ op: 'release', args: [id] }, 5_000);
});
