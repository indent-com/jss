# @indent-com/jss — design and implementation

Written before implementation, 2026-09-18. Confirmed requirements: TypeScript
for Node.js and browsers using WebAssembly; high-level helpers and a full handle
API; vendored quickjs-ng; builds through `flake.nix`; npm publishing through
`bin/publish` invoked by CI; off-thread execution and promises; time, memory and
stack limits for untrusted guest code. The author asked to continue implementation
after this document. The confirmed GitHub repository is `indent-com/jss`.

## Experience

```ts
import { evaluate, createSandbox } from '@indent-com/jss';
const answer = await evaluate<number>('6 * 7');
const sandbox = await createSandbox({
  execution: 'worker', // default; 'inline' is explicit
  memoryLimitBytes: 64 * 1024 * 1024,
  stackLimitBytes: 512 * 1024,
  timeoutMs: 1_000,
  globals: { greeting: 'Hello' },
});
try {
  await sandbox.expose('lookup', async (id: string) => ({ id, name: 'Ada' }));
  const message = await sandbox.evaluate<string>(`
    const person = await lookup('ada');
    greeting + ', ' + person.name
  `, { filename: 'greeting.js' });

  const counter = await sandbox.evaluateHandle(`({
    value: 0, increment(n) { this.value += n; return this.value }
  })`);
  try {
    const result = await counter.invoke('increment', [2]);
    try { console.log(await result.dump()); }
    finally { await result.dispose(); }
  } finally { await counter.dispose(); }
} finally { await sandbox.dispose(); }
```

Compile TypeScript to ESM and declarations. Ship one portable WASM artifact with
Node and browser adapters and their Workers. Support Node 22+, Linux x64/arm64
with glibc/musl, macOS arm64, and modern browsers with WASM and module Workers.
No runtime npm dependencies or installation scripts are necessary.

## API

All engine operations return promises, including invalid-input failures. Generic
result types document expectations; they do not validate guest output.

| High-level method | Contract |
| --- | --- |
| `createSandbox(options)` | New isolated persistent sandbox |
| `evaluate(source, options)` | One-shot copied result, dispose in finally |
| `withSandbox(options, fn)` | Scoped sandbox with guaranteed cleanup |
| `sandbox.evaluate<T>(source, options)` | Await and copy script completion |
| `sandbox.set(name, value)` / `get<T>(name)` | Literal global property access |
| `sandbox.call<T>(name, args, options)` | Call global function, global receiver, await and copy result |
| `sandbox.expose(name, callback)` | Host function with copied arguments/results |
| `sandbox.dispose()` | Idempotent terminal cleanup |

Evaluation supports top-level await with `JS_EVAL_FLAG_ASYNC`, preserving script
scope and completion values. Verify and unwrap the engine's async completion
convention. Never generate an async-function wrapper around arbitrary scripts.
Options include filename, timeoutMs and AbortSignal; other guest operations use
the default deadline, since property access/reflection can execute guest code.

Handle entry points: `evaluateHandle`, `handle(value)`, `global`, and
`createFunction(callback)`. Evaluation handles await script completion. Handle
property reads and calls preserve exact results, including promise identity.

| Handle method | Contract |
| --- | --- |
| `type()` | Guest category |
| `get(key)` / `set(key, value)` | Ordinary property access including accessors |
| `has(key)` / `delete(key)` / `keys()` | Membership, deletion, own enumerable string keys |
| `call(thisValue, args)` | Explicit receiver |
| `invoke(key, args)` / `construct(args)` | Method or constructor invocation |
| `await(options)` | Assimilate promise/thenable and return owned handle |
| `equals(other)` | Strict guest equality |
| `dump<T>()` | Copy supported data |
| `dup()` / `dispose()` | Independent reference / idempotent release |

Arguments accept copied values or same-sandbox handles. Keys accept strings,
numbers and symbol handles. Cross-sandbox and disposed references reject before
engine entry. IDs include sandbox identity/generation and never expose pointers.
All returned handles are owned; disposal of the sandbox frees every outstanding
handle. Add Symbol.asyncDispose convenience, but explicit cleanup is the contract.
Cap live handles. An in-flight operation retains its operands until completion.

`expose` snapshots copied arguments at guest invocation. `createFunction` receives a receiver handle and argument
handles in a temporary callback scope. They stay valid until the callback
settles; `dup` retains one longer. Callbacks return copied data or a same-sandbox
handle. Convert the return value before releasing the callback scope. Guest host
calls always return promises, even when the host function returns synchronously.

## Architecture and scheduling

Each sandbox owns one WASM instance/memory, JSRuntime and JSContext on one thread.
Worker mode uses a Node Worker or browser module Worker. Inline mode uses the
same driver on the caller's thread. One shared implementation owns all scheduling.

```
Application thread                     Node/Web Worker
Sandbox / Handle -- command + ID -->   driver -> C bridge -> QuickJS in WASM
Promise registry <-- result/error --   checked handle registry
Host callbacks   <-- callback/ID ---   guest promise capability
                 -- settlement ---->   resolve/reject, pump jobs
```

Only copied messages and IDs cross threads. Callbacks stay on the application
thread. Use Emscripten MODULARIZE + EXPORT_ES6 factory output, no pthreads,
shared memory, Asyncify or JSPI. Guest promises avoid suspending the WASM stack.
Cross-origin isolation is not required.

Start commands FIFO and serialize synchronous engine entry. While an operation
awaits a guest promise, permit other commands: interleaving across await lets
callbacks inspect/call guest handles without deadlock. Completion order may
vary; callers await when they need ordering. Operations are not transactions.
Disposal/cancellation/callback replies bypass admission limits. Bound queued and
active requests and callbacks. A C import queues a host call; invoke actual user
callbacks after WASM returns, never recursively during engine entry.

The bridge owns every QuickJS reference, including pending promise resolvers.
Use integer IDs with checked lookup. Prefer a small explicit C ABI for primitive
constructors, property/call operations, promise observation, jobs and exceptions.
Every success/failure path has a cleanup owner. No raw pointer is public.

Normalize await results through an intrinsic promise capability. Observe with
JS_PromiseState/Result/Then/MarkAsHandled, never mutable guest Promise methods.
Run JS_ExecutePendingJob in bounded batches and yield to host tasks. Empty jobs
can mean pending host I/O; wake on messages/timers instead of polling. Returned
rejections are not reported twice by rejection tracking. Deliver unrelated
unhandled rejections after a checkpoint through onUnhandledRejection.

Copied evaluation and global calls use one command that awaits and encodes the
result before releasing its internal watch; they do not create public handles.
Copied host calls carry encoded argument snapshots in their event, avoiding
separate argument-dump commands. Handle-based operations keep explicit ownership.
Short driver turns use microtasks. A cumulative 4 ms / 128-turn scheduling budget
persists across host promise continuations, then yields through a real host task.
Guest jobs drain in batches of 256 within that budget. This is a scheduling
target: individual guest commands/jobs can run longer, bounded by their actual
execution deadline. Scheduling yields never trigger the fatal interrupt deadline.

Every pending operation has a deadline beginning when the facade dispatches its
command, including time in the worker mailbox and driver queue. Apply the earliest
active deadline to the engine. Background jobs have a per-turn budget; detached
host calls have a deadline and belong to the sandbox. They may change persistent
state when settled. Runaway jobs or expired callbacks retire the sandbox. Late
replies carry generation IDs and cannot access freed state.

## Values and errors

Use the same checked transport in both modes. JSON alone is insufficient. A
fully tagged intermediate format can be encoded as JSON, but must not invoke
user toJSON hooks or silently lose types. Copy:

- undefined, null, booleans, numbers including NaN/infinities/negative zero;
- strings preserving UTF-16 units, including NUL and unpaired surrogates;
- arbitrary-precision bigint;
- arrays and plain records, own enumerable data properties and array holes;
- ArrayBuffer, DataView, integer/bigint typed arrays, Float32Array and Float64Array;
  keep Float16Array values as handles. Copy visible bytes, normalize
  offsets to zero, preserve element type; Node Buffer becomes Uint8Array.

Reject accessors, functions, symbols, promises, class instances, weak collections,
shared memory and cycles during copying; use handles for these. Repeated acyclic
references become independent copies. Define __proto__ as a data property. Cap
payloads at 16 MiB, depth at 100, nodes/array length at 100,000. Guest proxy traps
can execute during inspection, so conversion remains under the deadline. Host
values are trusted application input; same-thread host proxies cannot be preempted.
Refresh WASM views after memory growth and never expose linear-memory views.
Binary payloads travel as owned Uint8Array attachments, without base64 or JSON
byte arrays. Tagged JSON carries only attachment indices and element types.
Host encoding snapshots visible bytes synchronously. Worker messages transfer
these private buffers; caller buffers are never detached. Decoding returns
independent storage, with offset zero and no pooled or WASM backing memory.

At the WASM boundary, the adapter supplies a private table of byte pointers and
lengths alongside command JSON. Only the adapter handles pointers; worker
messages and public values carry owned bytes. Three native functions captured
by the private guest codec copy visible bytes, import an indexed attachment, and
export a private snapshot. Guest callback arguments are snapshotted during
encoding, before any later proxy trap or guest mutation can change them. Their
private ArrayBuffers count against the QuickJS heap while callbacks are queued.

The guest serializer recognizes snapshots by private identity, emits attachment
indices and retains those buffers until the adapter copies the response bytes.
It reports the exact JSON byte length, avoiding a terminator scan. The adapter
releases JSON and attachment references in a finally block, including errors;
runtime disposal also releases outstanding output before freeing its context.
Native getters are used only while the WASM stack is idle. Every allocation
that can grow memory precedes acquiring a fresh host view of WASM memory.

Keep the existing per-value copy quotas. Bound each bridge packet to 64 MiB of
JSON, attachment descriptors and bytes, and at most 100,000 attachments. Validate
indices, byte lengths and typed-array alignment before copying or constructing
views. No native attachment functions or snapshots are exposed to guest code;
lookalike user records and prototype hooks cannot forge an attachment.

Implementation order: replace host byte encoding, introduce the private native
attachment ABI and guest codec, enable worker transfer lists, then cover nested
and empty payloads, every view type, mutation timing, ownership, growth, quotas,
failure cleanup and poisoned intrinsics. Run one integrated check and regenerate
the existing current-results benchmark report using unchanged workloads.
Fixed job-status and empty-event replies bypass the guest JSON serializer;
job statuses also avoid allocating result objects. Deadline and rejection
checkpoint handling remain in place.
Global function calls share the invocation path directly, keeping the receiver,
callable and arguments alive without temporary handles or forwarding objects.

Preserve guest name/message/stack separately from host stack. Handle non-Error
throws and errors with malicious properties using bounded inspection and a safe
fallback. Stable codes distinguish guest, timeout, abort, disposed, invalid-handle,
clone, resource-limit, overload, initialization and worker failures.

## Limits and lifetime

Defaults: worker mode, 64 MiB QuickJS heap, 512 KiB guest stack, 1-second operation
timeout, 10-second initialization timeout, 128 outstanding operations. Validate
finite positive options. Set limits before user code and disable blocking
Atomics.wait. A monotonic interrupt hook runs no guest JS. Compile a 2 MiB C stack
and restrict guest stack settings below it with safety margin. Start with a
256 MiB maximum WASM memory. Verify stack exhaustion on the actual WASM build.
These limits are not process RSS limits; host heaps/messages use additional memory.
Cap handles, callbacks, source and bridge allocations separately.
Supply Emscripten's `malloc_usable_size` through `JS_NewRuntime2`: the vendored
default probe returns zero on Emscripten and misses cumulative large allocations.
Verify retained module sources and ArrayBuffers against the configured heap cap.

Active timeout/abort retires the entire sandbox, rejects all active/queued calls,
and invalidates handles/callbacks. No rollback is promised. Worker parents can
terminate guest execution independently, including infinite loops, without SAB.
Use this as a hard fallback and prove it in Node and browsers. Forced termination
reclaims the instance but does not guarantee guest finalizers.

Inline execution blocks its caller during guest CPU work. Cooperative deadlines
apply, but same-thread timers cannot deliver AbortSignal until execution yields.
A promise return value does not mean off-thread execution. A signal already
aborted before dispatch rejects only that request. Once dispatched, cancellation
retires the sandbox, including when that command is still in the worker mailbox.

Graceful disposal frees handles, callbacks, context, runtime and module references.
It bypasses the command queue, rejects outstanding work and terminates Workers
after bounded grace. Handle startup failure, disposal during startup, worker
exit, clone failure and late/duplicate replies. Every accepted request settles.

Guest code has no implicit network, filesystem, environment, Node globals,
timers or quickjs-libc std/os modules. Exposed host functions grant capabilities.
WASM memory containment and Worker termination do not promise process isolation
for hostile tenants or undo host side effects.

## Modules

`defineModule(name, source)` registers immutable source in a per-sandbox map;
`evaluateModuleHandle(name)` returns an owned namespace after evaluation, and
`evaluateModule(name)` copies its exports. QuickJS implements static/dynamic
imports, cycles, caching, live bindings and top-level await. Names canonicalize
to `jss:/` virtual paths or HTTP(S) URLs; `import.meta.url` reflects that identity.
The URL parser grants no I/O. Sources count toward the guest heap, with caps of
1,024 modules and 16 MiB aggregate UTF-8 source. Only registered sources load.
No public raw bytecode loading: upstream bytecode is version-specific and unsafe
for untrusted input.

The optional TypeScript runner under `examples/` supplies local-root and HTTP(S)
loading as explicit host capabilities. It checks types before transpilation and
registration. Dynamic imports are transformed through a private async loader,
then passed back to native module evaluation; this avoids Asyncify in the core
WASM engine. Example-only web API adapters and ponyfills live outside the npm
runtime and do not enlarge its WASM or add runtime dependencies.

The runner's REPL checks each cell against prior declarations, then executes only
the new cell in a persistent realm. Compilation runs in a bounded Node worker.
File modules preserve native live imports; REPL import declarations bind export
snapshots. Multiline input is explicit through `.editor` and `.end`; `.clear`
disposes the realm and its capabilities before creating a fresh session.

## Vendoring, build and artifacts

Vendor quickjs-ng v0.16.2, commit
1ab8676f4b6d6d669baeb5f21790fb9734636a20, under vendor/quickjs. Verified against
GitHub's API on 2026-09-18. Preserve MIT license, copyright and source layout.
Record URL/tag/commit/archive SHA-256, exclusions and patches in UPSTREAM.md.
Keep our bridge outside upstream. No submodule or build/install-time fetch.

Commit flake.nix and flake.lock. Expose build, npm tarball, dev shell and checks.
Pin Emscripten/Node/TypeScript/testing tools. Use build-local writable EM_CACHE;
no emsdk, optional-port or browser downloads in Nix build phases. Compile core
and bridge excluding CLI/libc capabilities. Set explicit WASM memory/stack caps,
minimal exports/imports and no host dynamic evaluation. Test without user caches.
Compile with `-Oz` to prioritize download size. Measurements favored it over LTO
for this engine. Retain the default allocator, JavaScript features and stack
checks; export only the runtime helpers used by the adapter. Size optimization
can trade execution speed for smaller code; see [BENCHMARKS.md](../BENCHMARKS.md)
for measurements of the shipped build against native QuickJS and Node.js.
Use direnv to load the flake's development shell and add `bin/` to PATH. Keep only
maintainer commands in `bin/`; build/pack/vendor helpers live in `scripts/` and
test runners in `test/`. `bin/publish` contains its implementation in one executable
using Node's built-in modules, with no launcher or sibling implementation file.

Use browser-safe generated glue; Node loads bytes in its own adapter. If two
glue variants prove necessary, keep one engine ABI and test both; do not patch
generated code with fragile replacements. Produce ESM, declarations and WASM.

```
direnv allow
nix build
nix flake check
publish --dry-run
publish
```

Locks establish reproducible inputs. Byte-identical builds require verification,
not assumption. Record engine/compiler versions in release metadata. No native
platform packages or compiler at npm install time.

Use conditional exports: types, node, browser-safe default; export explicit
browser/worker/WASM paths. Separate Node/browser worker entries. Keep browser
worker construction statically analyzable:
new Worker(new URL('./worker.js', import.meta.url), {type: 'module'}).
Resolve WASM relative to the module; offer wasmUrl and workerFactory overrides.
Factories create library-owned workers. Normalize URL strings before messages.
Document Worker/WASM CSP needs, with no automatic CDN dependency.

## CI and release

GitHub Actions builds one portable tarball and runs each suite once in a single
Linux job through `nix flake check`. Run the runtime suite against the installed
tarball on Node 24, plus distinct publisher, package, consumer-type and Chromium
checks. Do not repeat suites across OS, architecture, libc or Node-version matrices.
Test direct ESM and a production Vite consumer under a nested base path, overrides
and missing assets, both execution modes, no cross-origin isolation, and parent
responsiveness. Firefox and WebKit remain available for optional local testing.

Locally, plain `publish` builds `.#npm` through Nix, validates the artifact and
publishes using the caller's npm authentication, with terminal input available
for npm authentication and 2FA. Always select the newly resolved Nix output;
do not reuse an arbitrary `result` link. `--artifact PATH` skips the build.

A vX.Y.Z tag must match package.json for GitHub Actions. After all checks pass,
CI invokes bin/publish on the tested tarball with `--artifact`. Validate
tag/commit/version/name/repository/artifact digest and contents. CI does not
rebuild during publication. Dry-run performs validation with no registry write.
Explicit prerelease dist-tags protect latest. Existing npm
versions are immutable; retries must compare registry integrity before skipping.

Prefer OIDC trusted publishing and provenance on a GitHub-hosted runner. Give
id-token: write only to the publishing job. Current requirements: Node >=22.14,
npm >=11.5.1, exact repository/workflow relationship. New npm trusted publishers
default to staging as of 2026-09-03; configure direct publishing for automation.
An existing package, owner 2FA and authenticated initial publication may be needed
before trust can be configured. Repository files cannot perform account setup.
Implement/test the release mechanism and report external prerequisites honestly.

## Implementation sequence

1. Vendor/pin source; build WASM C bridge through Nix. Prove evaluation, cleanup,
   interrupts and stack limits early.
2. Implement handle ownership, reflection/calls, values, promise observation,
   callback capabilities and jobs.
3. Build TypeScript facade, inline driver, Node/Web Workers, limits and lifecycle.
   Run the same semantic tests in both modes.
4. Test infinite loops/jobs, unresolved promises, memory/stack exhaustion,
   conversion traps, overload, late replies, invalid handles, worker failure and
   concurrent disposal. Use external watchdogs for hang tests.
5. Install the actual tarball outside the checkout with scripts disabled; verify
   declarations, installed-package tests, real browser and production bundler assets.
6. Add bin/publish, CI, release dry-run checks, README and maintainer instructions.

Tests cover UTF-16, bigints, special numbers, holes/binary data, cyclic handle
graphs, symbol properties, getters/errors, promise identity, async callbacks and
concurrent operations. Repeat create/dispose/error cycles with leak diagnostics.
Use sanitizer checks for the bridge where practical; WASM is the release target.
Type-check examples and document incomplete verification explicitly.

## Primary references

- [Engine guide](https://quickjs-ng.github.io/quickjs/developer-guide/intro/)
- [Pinned header](https://github.com/quickjs-ng/quickjs/blob/v0.16.2/quickjs.h)
- [Release](https://github.com/quickjs-ng/quickjs/releases/tag/v0.16.2)
- [Emscripten modules](https://emscripten.org/docs/compiling/Modularized-Output.html)
- [Emscripten settings](https://emscripten.org/docs/tools_reference/settings_reference.html)
- [Node Workers](https://nodejs.org/api/worker_threads.html)
- [Vite Workers](https://vite.dev/guide/features.html#web-workers)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
