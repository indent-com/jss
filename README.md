# jss

JavaScript inside JavaScript, with a boundary you can control.

`@indent-com/jss` runs vendored [quickjs-ng](https://github.com/quickjs-ng/quickjs)
in WebAssembly. Evaluate a value, keep an isolated sandbox, or work with guest
objects through owned handles. Every operation returns a promise. Sandboxes run
in a Worker by default, in Node.js and browsers.

```sh
npm install @indent-com/jss
```

```ts
import { evaluate, withSandbox } from '@indent-com/jss';

const answer = await evaluate<number>('6 * 7'); // 42

const greeting = await withSandbox({ globals: { name: 'Ada' } }, async sandbox => {
  await sandbox.expose('lookup', async (name: string) => ({ name, role: 'engineer' }));
  return sandbox.evaluate<string>(`
    const person = await lookup(name);
    person.name + ' is an ' + person.role
  `);
});
```

Top-level `await` is supported without wrapping your source in a function.
Declarations persist across evaluations within a sandbox. Type parameters describe
the result you expect; they do not validate guest values.

## A sandbox you can keep

```ts
import { createSandbox } from '@indent-com/jss';

const sandbox = await createSandbox({
  execution: 'worker',
  timeoutMs: 1_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  stackLimitBytes: 512 * 1024,
});

try {
  await sandbox.set('factor', 7);
  await sandbox.evaluate('async function multiply(n) { return n * factor }');
  console.log(await sandbox.call<number>('multiply', [6])); // 42
} finally {
  await sandbox.dispose();
}
```

`evaluate(source, options)` creates a sandbox and disposes it after copying its
result. `withSandbox(options, fn)` keeps it alive for your callback and always
cleans up afterward. `createSandbox(options)` gives you explicit ownership.

| Sandbox operation | Result |
| --- | --- |
| `evaluate<T>(source, options?)` | Await script completion and copy its value |
| `evaluateHandle(source, options?)` | Await script completion and own a handle |
| `defineModule(name, source, options?)` | Register an immutable ES module source |
| `evaluateModuleHandle(name, options?)` | Await module evaluation and own its namespace |
| `evaluateModule<T>(name, options?)` | Evaluate a module and copy its exports |
| `set(name, value)` / `get<T>(name)` | Write or copy a literal global property |
| `call<T>(name, args?, options?)` | Call a global function and copy its awaited result |
| `expose(name, callback)` | Install a host function with copied arguments/results |
| `handle(value)` / `global()` | Own a copied value or the guest global object |
| `createFunction(callback)` | Create a host function using guest handles |
| `dispose()` | Idempotent cleanup; reject outstanding work |

`ExecutionOptions` accepts `filename`, `timeoutMs` and `signal`. Filenames appear
in guest error stacks. Operations can interleave while a guest promise awaits
completion, which lets host callbacks call back into their own sandbox. Await
each operation when order matters.

## Handles for objects that stay in the guest

Use handles for functions, symbols, accessors, class instances, cyclic graphs or
values you do not want to copy.

```ts
const counter = await sandbox.evaluateHandle(`({
  value: 40,
  add(n) { this.value += n; return this.value }
})`);

try {
  const result = await counter.invoke('add', [2]);
  try {
    console.log(await result.dump<number>()); // 42
  } finally {
    await result.dispose();
  }
} finally {
  await counter.dispose();
}
```

Each returned handle is owned. `dup()` creates an independently owned reference;
`dispose()` releases one reference. Disposing a sandbox invalidates all of its
handles. Both sandboxes and handles also support `Symbol.asyncDispose`.

| Handle operation | Purpose |
| --- | --- |
| `type()` / `dump<T>()` | Inspect its category or copy its value |
| `get(key)` / `set(key, value)` | Ordinary property access, including accessors |
| `has(key)` / `delete(key)` / `keys()` | Membership, deletion, enumerable own string keys |
| `call(receiver?, args?)` / `invoke(key, args?)` | Call a function or method |
| `construct(args?)` | Call a constructor |
| `await(options?)` | Await a promise or thenable into a new owned handle |
| `equals(value)` | Guest strict equality |
| `dup()` / `dispose()` | Retain or release a reference |

Property and call results preserve promise identity. Use `handle.await()` to
resolve them explicitly. Arguments may be copied values or handles from the same
sandbox. Property keys may also be symbol handles.

Host functions always return guest promises. `expose()` copies its arguments when
the guest invokes the function, before later guest mutations can change them;
`createFunction()` provides a receiver handle and an array of argument handles:

```ts
const echo = await sandbox.createFunction(async (_receiver, args) => args[0]);
try {
  await sandbox.set('echo', echo);
  console.log(await sandbox.evaluate('await echo({ answer: 42 })'));
} finally {
  await echo.dispose();
}
```

Callback handles remain valid until the callback settles. Call `dup()` to retain
one beyond that scope, and dispose the duplicate when finished. Returning a
same-sandbox handle preserves its guest identity.

## Values and errors

Copied values include `undefined`, `null`, booleans, numbers (including `NaN`,
infinities and negative zero), UTF-16 strings, bigint, arrays with holes, plain
records, ArrayBuffer, DataView, integer and bigint typed arrays, Float32Array and
Float64Array. Float16Array values can be kept as handles. Binary data is copied;
a view copies its visible bytes with an offset of zero. Node Buffer becomes
Uint8Array. Bytes use binary attachments across WASM and worker boundaries;
worker transfers never detach caller buffers. Shared memory is excluded.

Copying rejects functions, symbols, accessors, promises, class instances and
cycles. Use handles for those values. Repeated acyclic references become separate
copies. Copy limits are 16 MiB, 100 levels of nesting and 100,000 nodes or array
elements.

Guest failures reject with `SandboxError`, carrying `code`, `name`, `message`
and a separate `guestStack`. Host stack traces remain host stack traces.
Distinguish an ordinary guest exception (`ERR_GUEST`), an invalid reference
(`ERR_HANDLE`), a copying failure (`ERR_CLONE`), an execution timeout
(`ERR_TIMEOUT`), cancellation (`ERR_ABORTED`) and a disposed sandbox
(`ERR_DISPOSED`) through `error.code`.

## Execution and limits

Workers own independent WASM instances. They keep guest CPU work off the calling
thread and allow the parent to terminate an infinite loop. `execution: 'inline'`
uses the same promise-based API on the calling thread; guest CPU work blocks that
thread until the engine yields or its deadline interrupts it.

Defaults are a one-second operation timeout, a ten-second startup timeout,
64 MiB of QuickJS heap, a 512 KiB guest stack, and 128 outstanding operations.
`maxPendingOperations` controls admission. Every guest operation, including
property access and copying, runs with a deadline.

```ts
const controller = new AbortController();
const running = sandbox.evaluate('while (true) {}', {
  signal: controller.signal,
  timeoutMs: 5_000,
});
setTimeout(() => controller.abort(), 25);
await running; // rejects with ERR_ABORTED in worker mode
```

An active timeout or cancellation retires the entire sandbox, rejects its
outstanding operations and invalidates handles. Create another sandbox to
continue. A signal already aborted before dispatch only rejects that request.
Same-thread timers cannot interrupt inline execution until the host regains
control; inline mode relies on cooperative engine deadlines.

Guests receive no filesystem, network, Node globals or quickjs-libc `std`/`os`
modules. Exposed callbacks grant capabilities explicitly. Heap limits measure
QuickJS allocations, not process RSS. Workers and WASM do not promise process
isolation for hostile tenants or undo host callback side effects. Static imports,
dynamic `import()` and top-level await use explicitly registered module sources;
the core never reads files or fetches modules. Raw bytecode import is not exposed.

## Browsers and assets

The package root selects the Node adapter in Node and a browser adapter for
browser bundlers. `@indent-com/jss/browser` selects the browser adapter explicitly.
The npm tarball includes its Worker entry points, ESM glue and WASM binary;
installation does not download an engine or run a compiler.

Vite production builds are exercised under a nested base path. Native browser
ESM also works when the package is served over HTTP with its relative directory
layout intact. Serve `.wasm` as `application/wasm`. No shared memory or
cross-origin-isolation headers are required.

For custom asset pipelines:

```ts
const sandbox = await createSandbox({
  wasmUrl: new URL('/assets/quickjs.wasm', location.href),
  workerFactory: () => new Worker('/assets/jss-worker.js', { type: 'module' }),
});
```

The library owns and terminates Workers returned by `workerFactory`. The worker
must be the packaged worker or a bundled entry importing
`@indent-com/jss/worker`. The WASM binary is exported at
`@indent-com/jss/quickjs.wasm`. Asset overrides are optional; normal package
imports resolve local assets automatically. Your Content Security Policy must
allow your Worker and WASM sources, including WebAssembly compilation where the
browser requires `wasm-unsafe-eval`. No CDN is used automatically.

## Build and contribute

The [design and implementation document](docs/design.md) describes the ownership,
scheduling, bridge and release contracts. QuickJS source is vendored under
`vendor/quickjs`, with its revision and archive checksum in
[UPSTREAM.md](vendor/quickjs/UPSTREAM.md). The bridge is maintained separately.
With direnv and nix-direnv installed, `.envrc` loads the pinned toolchain and adds
`bin/` to PATH. Only maintainer-facing commands belong there; build and vendoring
helpers live in `scripts/`, and test runners live in `test/`.

```sh
direnv allow
tests                     # build and run each suite once against the npm tarball
nix build .#npm --out-link result-npm
```

For local iteration, `npm ci --ignore-scripts` and `npm run build` prepare `dist/`;
`npm test` runs the Node tests and `npm run test:browser` runs browser tests.
`nix build` produces the ESM, declarations and WASM without running tests.

Nix pins the compiler and npm dependency inputs. The WASM build uses vendored
source, `-Oz` size optimization and a build-local Emscripten cache. Size is
prioritized over peak execution speed; JavaScript features and resource-limit
checks remain enabled. Reproducible inputs are established by
the lock files; byte-for-byte reproducibility needs a separate rebuild comparison.

Runtime tests exercise both execution modes. Dangerous loops, promise chains,
memory/stack exhaustion and cancellation run under an independent process
watchdog. Browser tests use Playwright against native ESM and an installed-package
Vite production build. Set `JSS_BROWSERS=chromium,firefox,webkit` to select all
three engines locally. CI runs `bin/tests` once on Linux with Node 24 and
Chromium. The runtime suite tests the installed npm tarball; packaging, publisher
and consumer-type checks run alongside it. The same WASM artifact serves every
supported platform, with no OS, architecture, libc or Node-version test matrix.

Runnable examples live in [examples](examples): `node examples/basic.mjs` and
`node examples/handles.mjs` after building.

`node examples/fibonacci.mjs 100` computes Fibonacci in an off-thread guest using
`BigInt`. `node examples/capabilities.mjs` runs a type-checked TypeScript program
with filesystem, local/HTTP module loading, Fetch and WebSocket capabilities
against a temporary directory and local demo server. See the
[runner guide](examples/README.md) for permissions, API details and limitations.

For a persistent TypeScript REPL, start the local example service in one terminal:

```sh
node examples/capabilities.mjs --serve
```

Then start the runner in another terminal:

```sh
node examples/runner.mjs --repl --root examples/capabilities/fixtures \
  --allow-origin http://127.0.0.1:8787
```

```ts
jss> import { fibonacci } from './math.ts'
jss> const { greeting } = await import('http://127.0.0.1:8787/remote.ts')
jss> if (fibonacci(10) !== 55n) throw new Error('Fibonacci test failed')
jss> greeting('QuickJS')
'Hello, QuickJS, from an HTTP module'
jss> fibonacci(10) === 55n
true
jss> .exit
```

Each submission is type-checked against the session's earlier declarations.
Use `.editor` and `.end` for multiline input, `.break` to discard it, or `.clear`
to create a fresh guest realm.

## Benchmarks

Run `benchmark` after building to measure compute, promises, public calls
and async host callbacks against native QuickJS-NG, Node.js and a Node worker.
It builds the native harness through Nix and writes [BENCHMARKS.md](BENCHMARKS.md)
with timings, ratios, batch counts and environment details. Benchmarks run
manually, outside CI correctness checks. Binary copy round trips and full guest
buffer scans are measured separately; buffer preparation is outside the timer.
Both `bin/tests` and `bin/benchmark` are available on PATH through direnv;
`tests` forwards additional arguments to `nix flake check`.

## Release

```sh
publish
```

`bin/publish` is a self-contained Node.js executable using only built-in modules.
It builds `.#npm` through Nix, validates the tarball and its `release.json`, and
publishes using your npm authentication. npm can prompt for authentication or
2FA in the terminal. Use `publish --dry-run` to build and validate without a
registry write, or `publish --artifact PATH` to use an existing tarball.
CI invokes `bin/publish --artifact PATH` for a `vX.Y.Z` tag matching the package
version only after the build, installed-package and browser checks pass. It
publishes the tested tarball with provenance, verifies its digest and release
context, and accepts retries only when npm already has identical bytes.
Prereleases default to `next`; they cannot publish under `latest`.

An npm owner must configure trusted publishing for GitHub repository
`indent-com/jss`, workflow `ci.yml`, with direct publication enabled. The publish
job needs `id-token: write`, Node >=22.14 and npm >=11.5.1. A new package may need
an authenticated initial publication before npm trust can be configured. These
account settings are external to this repository. See the release section of the
[design document](docs/design.md#ci-and-release).

MIT. Vendored components retain their notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
