import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSandbox, evaluate, withSandbox, SandboxError } from '../dist/node.js';

const code = (expected) => (error) => {
  assert.ok(error instanceof SandboxError, `Expected SandboxError, got ${error}`);
  assert.equal(error.code, expected);
  return true;
};

for (const execution of ['inline', 'worker']) {
  const scoped = (fn, options = {}) => withSandbox({ execution, timeoutMs: 2_000, ...options }, fn);
  const check = (name, fn) => test(`${execution}: ${name}`, { timeout: 20_000 }, fn);

  check('one-shot evaluation, promise completion and persistent top-level await', async () => {
    assert.equal(await evaluate('6 * 7', { execution }), 42);
    await scoped(async (sandbox) => {
      assert.equal(await sandbox.evaluate('let count = 4; count'), 4);
      assert.equal(await sandbox.evaluate('await Promise.resolve(); count += 3; count'), 7);
      assert.equal(await sandbox.evaluate('Promise.resolve(count * 6)'), 42);
      assert.equal(await sandbox.evaluate('await Promise.resolve(40) + 2'), 42);
      assert.equal(await sandbox.evaluate('count'), 7);
    });
  });

  check('literal global names, functions and no implicit host capabilities', async () => {
    await scoped(async (sandbox) => {
      await sandbox.set('not.an.expression', { value: 42 });
      assert.deepEqual(await sandbox.get('not.an.expression'), { value: 42 });
      await sandbox.evaluate('globalThis.factor = 7; globalThis.multiply = async function (n) { return this.factor * n }; undefined');
      assert.equal(await sandbox.call('multiply', [6]), 42);
      assert.deepEqual(await sandbox.evaluate('[typeof process, typeof require, typeof fetch, typeof std, typeof os]'),
        ['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    });
  });

  check('copied values preserve UTF-16, special numbers, bigint, holes and own __proto__', async () => {
    await scoped(async (sandbox) => {
      const array = [undefined, , null, -0, NaN, Infinity, -Infinity, 2n ** 100n, 'nul\0 lone\ud800 pair\ud83d\udc08'];
      array.extra = { enabled: true };
      const record = { array };
      Object.defineProperty(record, '__proto__', { enumerable: true, value: { polluted: true } });
      await sandbox.set('payload', record);
      const copied = await sandbox.get('payload');
      assert.deepEqual(copied, record);
      assert.equal(1 in copied.array, false);
      assert.equal(Object.getPrototypeOf(copied), Object.prototype);
      assert.equal({}.polluted, undefined);
      assert.deepEqual(await sandbox.evaluate('({ value: 123456789012345678901234567890n, text: "\\ud800\\u0000", zero: -0, sparse: [, 2] })'),
        { value: 123456789012345678901234567890n, text: '\ud800\0', zero: -0, sparse: [, 2] });
    });
  });

  check('binary values copy visible bytes and preserve their type', async () => {
    await scoped(async (sandbox) => {
      const source = new Uint8Array([8, 1, 2, 3, 9]);
      const input = {
        bytes: source.subarray(1, 4),
        signed: new Int16Array([-32768, 42, 32767]),
        floating: new Float64Array([-0, NaN, Infinity]),
        wide: new BigInt64Array([-9n, 2n ** 60n]),
        view: new DataView(source.buffer, 1, 3),
        buffer: source.buffer,
        node: Buffer.from([4, 5]),
      };
      await sandbox.set('binary', input);
      const output = await sandbox.get('binary');
      assert.deepEqual(output.bytes, new Uint8Array([1, 2, 3]));
      assert.equal(output.bytes.byteOffset, 0);
      assert.deepEqual(output.signed, input.signed);
      assert.deepEqual(output.floating, input.floating);
      assert.deepEqual(output.wide, input.wide);
      assert.ok(output.view instanceof DataView);
      assert.equal(output.view.byteOffset, 0);
      assert.deepEqual(new Uint8Array(output.view.buffer), new Uint8Array([1, 2, 3]));
      assert.deepEqual(output.buffer, input.buffer);
      assert.deepEqual(output.node, new Uint8Array([4, 5]));
      output.bytes[0] = 99;
      assert.equal(await sandbox.evaluate('binary.bytes[0]'), 1);
    });
  });

  check('copy rejects unsupported values without invoking host accessors', async () => {
    await scoped(async (sandbox) => {
      let getterCalls = 0;
      const accessor = { get secret() { getterCalls++; return 42; } };
      const cycle = {}; cycle.self = cycle;
      for (const value of [accessor, cycle, new Date(), new Map(), Promise.resolve(1), Symbol('x'), () => 1]) {
        await assert.rejects(sandbox.handle(value), code('ERR_CLONE'));
      }
      assert.equal(getterCalls, 0);
      for (const source of ['({ get secret() { throw Error("getter ran") } })', 'new Date()', '(() => { const x = {}; x.self = x; return x })()']) {
        await assert.rejects(sandbox.evaluate(source), code('ERR_CLONE'));
      }
      assert.equal(await sandbox.evaluate('42'), 42);
    });
  });

  check('guest errors retain name, message and guest filename', async () => {
    await scoped(async (sandbox) => {
      await assert.rejects(sandbox.evaluate('throw new TypeError("guest failure")', { filename: 'guest-example.js' }), (error) => {
        assert.ok(error instanceof SandboxError);
        assert.equal(error.code, 'ERR_GUEST');
        assert.equal(error.name, 'TypeError');
        assert.equal(error.message, 'guest failure');
        assert.match(error.guestStack, /guest-example\.js/);
        return true;
      });
      for (const source of ['throw null', 'throw "plain failure"', 'Promise.reject(new Error("rejected"))']) {
        await assert.rejects(sandbox.evaluate(source), code('ERR_GUEST'));
      }
      await assert.rejects(sandbox.evaluate('function {'), code('ERR_GUEST'));
      assert.equal(await sandbox.evaluate('40 + 2'), 42);
    });
  });

  check('handles support accessors, methods, properties, identity and independent duplicates', async () => {
    await scoped(async (sandbox) => {
      const object = await sandbox.evaluateHandle('({ count: 1, get double() { return this.count * 2 }, add(n) { this.count += n; return this.count } })');
      const duplicate = await object.dup();
      assert.equal(await object.type(), 'object');
      assert.equal(await object.equals(duplicate), true);
      await object.set('count', 20);
      const result = await object.invoke('add', [1]);
      assert.equal(await result.dump(), 21);
      await result.dispose();
      const doubled = await object.get('double');
      assert.equal(await doubled.dump(), 42);
      await doubled.dispose();
      await object.set('extra', true);
      assert.equal(await object.has('extra'), true);
      assert.equal(await object.delete('extra'), true);
      assert.equal(await object.has('extra'), false);
      assert.deepEqual(await object.keys(), ['count', 'double', 'add']);
      await object.dispose();
      await object.dispose();
      await assert.rejects(object.type(), code('ERR_HANDLE'));
      assert.equal(await duplicate.type(), 'object');
      await duplicate.dispose();
    });
  });

  check('handles support constructors, explicit receivers, symbols and cyclic graphs', async () => {
    await scoped(async (sandbox) => {
      const constructor = await sandbox.evaluateHandle('(class Counter { constructor(n) { this.n = n } plus(n) { return this.n + n } })');
      const instance = await constructor.construct([40]);
      const fn = await instance.get('plus');
      const result = await fn.call(instance, [2]);
      assert.equal(await result.dump(), 42);
      const symbol = await sandbox.evaluateHandle('Symbol("key")');
      assert.equal(await symbol.type(), 'symbol');
      await instance.set(symbol, 'secret');
      const secret = await instance.get(symbol);
      assert.equal(await secret.dump(), 'secret');
      await instance.set('self', instance);
      const self = await instance.get('self');
      assert.equal(await self.equals(instance), true);
      await assert.rejects(instance.dump(), code('ERR_CLONE'));
      await Promise.all([self, secret, symbol, result, fn, instance, constructor].map(handle => handle.dispose()));
    });
  });

  check('property and call handles preserve promises until explicitly awaited', async () => {
    await scoped(async (sandbox) => {
      const container = await sandbox.evaluateHandle('({ value: Promise.resolve(42), method() { return this.value } })');
      const promise = await container.get('value');
      const returned = await container.invoke('method');
      assert.equal(await promise.equals(returned), true);
      await assert.rejects(promise.dump(), code('ERR_CLONE'));
      const resolved = await promise.await();
      assert.equal(await resolved.dump(), 42);
      await Promise.all([resolved, returned, promise, container].map(handle => handle.dispose()));
    });
  });

  check('invocation retains operands before caller disposal', async () => {
    await scoped(async (sandbox) => {
      const object = await sandbox.evaluateHandle('({ offset: 2, method(value) { return this.offset + value.answer } })');
      const argument = await sandbox.handle({ answer: 40 });
      const invocation = object.invoke('method', [argument]);
      const cleanup = Promise.all([object.dispose(), argument.dispose()]);
      const result = await invocation;
      assert.equal(await result.dump(), 42);
      await result.dispose(); await cleanup;

      await sandbox.evaluate('function add(value) { return value.answer + 2 }');
      const secondArgument = await sandbox.handle({ answer: 40 });
      const called = sandbox.call('add', [secondArgument]);
      const released = secondArgument.dispose();
      assert.equal(await called, 42);
      await released;
    });
  });

  check('bridge copying tolerates poisoned guest prototypes and replaced intrinsics', async () => {
    await scoped(async (sandbox) => {
      await sandbox.expose('copiedEcho', (value) => value);
      await sandbox.evaluate(`
        globalThis.payload = { answer: 42, sparse: [1, , 3] };
        const descriptor = Object.create(null);
        descriptor.set = function () { throw Error('array index setter'); };
        descriptor.configurable = true;
        Object.defineProperty(Array.prototype, '0', descriptor);
        Object.prototype.handle = 99999;
        Object.prototype.toJSON = function () { throw Error('toJSON hook'); };
        Object.prototype.value = 'inherited descriptor value';
        Object.prototype.get = function () { throw Error('inherited descriptor getter'); };
        Number.isInteger = function () { return false; };
        JSON.stringify = function () { throw Error('replaced stringify'); };
        undefined
      `);
      assert.deepEqual(await sandbox.get('payload'), { answer: 42, sparse: [1, , 3] });
      assert.deepEqual(await sandbox.evaluate('await copiedEcho(payload)'), { answer: 42, sparse: [1, , 3] });
      await sandbox.set('fromHost', { answer: 42, list: [4, 5] });
      assert.deepEqual(await sandbox.get('fromHost'), { answer: 42, list: [4, 5] });
      await assert.rejects(sandbox.evaluate('({ get secret() { throw Error("getter ran") } })'), code('ERR_CLONE'));
    });
  });

  check('awaiting a guest promise does not call a replaced Promise.prototype.then', async () => {
    await scoped(async (sandbox) => {
      assert.equal(await sandbox.evaluate('({ then(resolve) { resolve(42) } })'), 42);
      const container = await sandbox.evaluateHandle('({ promise: Promise.resolve(42) })');
      const promise = await container.get('promise');
      await sandbox.evaluate('Promise.prototype.then = function () { throw Error("replaced then") }; undefined');
      const resolved = await promise.await();
      assert.equal(await resolved.dump(), 42);
      assert.equal(await sandbox.evaluate('Promise.resolve(42)'), 42);
      await Promise.all([resolved, promise, container].map(handle => handle.dispose()));
    });
  });

  check('malicious thrown values remain bounded guest failures', async () => {
    await scoped(async (sandbox) => {
      await assert.rejects(sandbox.evaluate('throw { get name() { throw 1 }, get message() { throw 2 }, get stack() { throw 3 } }'), code('ERR_GUEST'));
      await assert.rejects(sandbox.evaluate('throw Object.assign(new Error("ordinary guest error"), { code: "ERR_TIMEOUT" })'), code('ERR_GUEST'));
      assert.equal(sandbox.disposed, false);
      assert.equal(await sandbox.evaluate('42'), 42);
    });
  });

  check('unrelated unhandled rejections are reported once and observed rejections are suppressed', async () => {
    const reports = [];
    await scoped(async (sandbox) => {
      await sandbox.evaluate('Promise.reject(new Error("detached failure")); undefined');
      // A host task boundary gives the engine its rejection-reporting checkpoint.
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(reports.length, 1);
      assert.equal(reports[0].message, 'detached failure');
      await assert.rejects(sandbox.evaluate('Promise.reject(new Error("observed failure"))'), code('ERR_GUEST'));
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(reports.length, 1);
    }, { onUnhandledRejection: error => reports.push(error) });
  });

  check('copied callbacks can resolve, reject and reenter their sandbox', async () => {
    await scoped(async (sandbox) => {
      await sandbox.expose('lookup', async (id) => ({ id, name: 'Ada' }));
      assert.deepEqual(await sandbox.evaluate('await lookup("a")'), { id: 'a', name: 'Ada' });
      await sandbox.expose('twice', async (n) => (await sandbox.evaluate('21')) + n);
      assert.equal(await sandbox.evaluate('await twice(21)'), 42);
      await sandbox.expose('fail', async () => { throw new RangeError('host failure'); });
      assert.deepEqual(await sandbox.evaluate('try { await fail() } catch (e) { [e.name, e.message] }'), ['RangeError', 'host failure']);
      assert.equal(await sandbox.evaluate('lookup("x") instanceof Promise'), true);
      let copiedCalls = 0;
      await sandbox.expose('copyAtCall', (value) => { copiedCalls++; return value; });
      assert.deepEqual(await sandbox.evaluate('const mutable = { value: 1 }; const snapshot = copyAtCall(mutable); mutable.value = 2; await snapshot'), { value: 1 });
      assert.deepEqual(await sandbox.evaluate('try { await copyAtCall(() => 1) } catch (error) { [error.name, error.code] }'), ['DataCloneError', 'ERR_CLONE']);
      assert.equal(copiedCalls, 1);
    });
  });

  check('handle callbacks receive temporary scopes and may retain duplicates', async () => {
    await scoped(async (sandbox) => {
      let borrowed, retained;
      const callback = await sandbox.createFunction(async (receiver, args) => {
        const marker = await receiver.get('marker');
        try { assert.equal(await marker.dump(), 7); } finally { await marker.dispose(); }
        borrowed = args[0];
        retained = await borrowed.dup();
        return borrowed;
      });
      await sandbox.set('hostEcho', callback);
      const result = await sandbox.evaluateHandle('globalThis.item = { answer: 42 }; await hostEcho.call({ marker: 7 }, item)');
      assert.equal(await result.equals(retained), true);
      assert.equal(borrowed.disposed, true);
      await assert.rejects(borrowed.dump(), code('ERR_HANDLE'));
      assert.deepEqual(await retained.dump(), { answer: 42 });
      await Promise.all([callback, result, retained].map(handle => handle.dispose()));
    });
  });

  check('pending guest promises allow independent work and disposal settles callers', async () => {
    const sandbox = await createSandbox({ execution, timeoutMs: 2_000 });
    const pending = sandbox.evaluate('new Promise(() => {})');
    const rejected = assert.rejects(pending, code('ERR_DISPOSED'));
    try {
      assert.equal(await sandbox.evaluate('42'), 42);
      await sandbox.dispose();
      await rejected;
      assert.equal(sandbox.disposed, true);
      await assert.rejects(sandbox.evaluate('1'), code('ERR_DISPOSED'));
      await sandbox.dispose();
    } finally { await sandbox.dispose(); }
  });

  check('aborted requests reject without retiring an otherwise idle sandbox', async () => {
    await scoped(async (sandbox) => {
      const controller = new AbortController(); controller.abort();
      await assert.rejects(sandbox.evaluate('1', { signal: controller.signal }), code('ERR_ABORTED'));
      assert.equal(await sandbox.evaluate('42'), 42);
    });
  });

  check('outstanding operation cap rejects excess work and cleanup still succeeds', async () => {
    const sandbox = await createSandbox({ execution, maxPendingOperations: 1, timeoutMs: 2_000 });
    const pending = sandbox.evaluate('new Promise(() => {})');
    const rejected = assert.rejects(pending, code('ERR_DISPOSED'));
    try {
      await assert.rejects(sandbox.evaluate('42'), code('ERR_QUEUE_FULL'));
      await sandbox.dispose();
      await rejected;
    } finally { await sandbox.dispose(); }
  });

  check('withSandbox cleans up after caller errors', async () => {
    let sandbox;
    const expected = new Error('application failure');
    await assert.rejects(scoped(async (value) => { sandbox = value; throw expected; }), error => error === expected);
    assert.equal(sandbox.disposed, true);
  });
}

test('cross-sandbox references are rejected before entering the engine', async () => {
  await withSandbox({ execution: 'inline' }, async (first) => {
    await withSandbox({ execution: 'worker' }, async (second) => {
      const value = await first.handle({ answer: 42 });
      const other = await second.handle({});
      await assert.rejects(second.set('foreign', value), code('ERR_HANDLE'));
      await assert.rejects(other.equals(value), code('ERR_HANDLE'));
      await value.dispose(); await other.dispose();
    });
  });
});

test('invalid options and inputs fail through promises', async () => {
  for (const options of [{ execution: 'invalid' }, { timeoutMs: 0 }, { memoryLimitBytes: Infinity }, { stackLimitBytes: 2 ** 22 }, { maxPendingOperations: -1 }]) {
    let promise;
    assert.doesNotThrow(() => { promise = createSandbox(options); });
    assert.ok(promise instanceof Promise);
    await assert.rejects(promise, code('ERR_OPTIONS'));
  }
  await withSandbox({ execution: 'inline' }, async (sandbox) => {
    let promise;
    assert.doesNotThrow(() => { promise = sandbox.evaluate(42); });
    await assert.rejects(promise, code('ERR_SOURCE'));
  });
});
