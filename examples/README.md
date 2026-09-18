# Examples

The examples run from a checkout with direnv enabled:

```sh
direnv allow
npm ci --ignore-scripts
npm run build
node examples/fibonacci.mjs 100
node examples/capabilities.mjs
```

`fibonacci.mjs` computes an exact `BigInt` result in an off-thread QuickJS realm.
`capabilities.mjs` starts a local HTTP/WebSocket service, creates a temporary
filesystem root, executes `capabilities/fixtures/main.ts`, and cleans everything
up. It needs no external service. The guest program uses files, static imports,
computed dynamic HTTP imports, Fetch streams/forms and WebSocket text/binary.

## Run your own TypeScript

```sh
node examples/runner.mjs --root ./scripts --allow-origin https://example.com main.ts
```

`main.ts` is relative to `--root`. An HTTP(S) URL can also be the entry module.
Repeat `--allow-origin` to grant another origin. Network access is denied by
default, including HTTP module imports; every HTTP redirect is checked again.
A granted HTTP origin also permits its corresponding WebSocket origin. Script
arguments follow `--` and are available as the readonly `args` array.

TypeScript is checked before code executes. Local and remote dependency graphs
are checked together, and computed dynamic imports are checked when loaded.
Diagnostics identify the source, line and column. Compiler parsing, type-checking
and transpilation run in a separate Node worker with a 15-second deadline and a
384 MiB old-generation heap limit. The guest has its own 128 MiB QuickJS heap and
15-second execution deadline; `--timeout MS` changes the guest deadline. Heap
limits do not measure total process memory. Only the globals installed by this
example are advertised as runtime values in its TypeScript environment.

An entry module may `export const result = ...` to return a copy to the host.
`console.log`, `info`, `warn`, `error` and `debug` forward copied values to Node.
Use `.js`, `.mjs`, `.ts` or `.mts` extensions explicitly. There is no npm, `node:`,
CommonJS or implicit package resolution. JavaScript modules are accepted;
TypeScript modules use strict type-checking. Source limits are 1 MiB per module,
128 files and 16 MiB per graph. Import attributes other than an empty set are
rejected; this example only loads JavaScript and TypeScript modules.

Static imports and `import()` retain QuickJS's module cache, cycles, live exports
and top-level await. Dynamic import expressions are transformed through a private
asynchronous source loader; no Asyncify is required in the WASM engine. The core
library only loads explicitly registered modules and never acquires host I/O.

## REPL

Start the example HTTP service in one terminal:

```sh
node examples/capabilities.mjs --serve
```

In another terminal:

```sh
node examples/runner.mjs --repl --root examples/capabilities/fixtures \
  --allow-origin http://127.0.0.1:8787
```

```text
jss> import { fibonacci } from './math.ts'
jss> const { greeting } = await import('http://127.0.0.1:8787/remote.ts')
jss> if (fibonacci(10) !== 55n) throw new Error('Fibonacci test failed')
jss> greeting('QuickJS')
'Hello, QuickJS, from an HTTP module'
jss> fibonacci(10) === 55n
true
jss> const answer: number = 'wrong'
...TypeScript diagnostic...
jss> .exit
```

Declarations persist. Each submission is checked against earlier submissions,
then only that submission executes. REPL imports bind snapshots of module
exports; imports within module files retain native live bindings. `.editor`
begins multiline input, `.end` evaluates it, `.break` discards it, `.clear`
creates a fresh guest realm, and `.exit` quits. EOF also closes the runner.
Runtime errors can leave declarations and side effects behind. After a timeout
retires the sandbox, `.clear` starts a new realm.

## Filesystem capability

All operations are asynchronous and relative to the configured root. Paths that
escape it and symbolic links are rejected. This is an example capability boundary
for an application-owned directory, not an OS sandbox against another process
concurrently replacing directories. No raw Node `fs` object or file handle enters
the guest. The root is explicitly writable.

| API | Behavior |
| --- | --- |
| `fs.readText(path, { maxChars }?)` | UTF-8 text; limit counts Unicode code points |
| `fs.readBytes(path, { maxBytes }?)` | `Uint8Array`, optionally truncated |
| `fs.writeText(path, text)` | Write UTF-8 text |
| `fs.writeBytes(path, bytes)` | Write a `Uint8Array` |
| `fs.WriteBytes(path, bytes)` | Alias for `writeBytes` |
| `fs.glob(pattern)` | Sorted root-relative matches |
| `fs.stat(path)` | Type, size, mode and timestamp metadata |
| `fs.readDir(path?)` | Directory entry names and types |
| `fs.mkdir(path, { recursive }?)` | Create a directory |
| `fs.remove(path, { recursive }?)` | Remove a file or directory |
| `fs.rename(from, to)` / `fs.copy(from, to)` | Move or copy within the root |
| `fs.exists(path)` | Check existence |

Defaults bound reads/writes to 8 MiB and listings to 10,000 entries. Whole reads
that exceed the byte limit reject; explicit `maxChars`/`maxBytes` requests may
read a prefix. `globals.d.ts` contains the guest filesystem declarations.

## Fetch and WebSocket

The adapters install `fetch`, `Request`, `Response`, `Headers`, Web Streams,
`Blob`, `File`, `FormData`, `URL`, encoding, events and abort primitives. They
provide streaming uploads/downloads, body readers, cloning and `bodyUsed`,
abort signals, redirects, integrity, multipart data, `data:` URLs, and Blob URLs
through `URL.createObjectURL`/`revokeObjectURL`. Network I/O and multipart parsing
use Node's implementations. Streams cross the bridge in 64 KiB chunks.

`WebSocket` includes state, protocol/extensions, `bufferedAmount`, `binaryType`,
text/Blob/ArrayBuffer/view sends, close codes/reasons, event listeners and `on*`
handlers. Internal chunking preserves message boundaries. Native Node manages
handshake, TLS and framing. `bufferedAmount` includes bridge-queued bytes and the
latest host transport snapshot; host observations arrive asynchronously.

This is the Node-hosted Web API surface: there is no browser document, cookie
jar, CSP enforcement or browser HTTP cache. Network URLs must be absolute.
Node-specific Fetch dispatcher extensions and nonstandard WebSocket ping/pong
methods are not exposed. The adapters are not certified against the full Web
Platform Tests; constructor/coercion edge-case conformance remains unverified.

Default capability quotas are 8 MiB per HTTP body, 32 active requests, a 30-second
host HTTP deadline, 16 sockets, 8 MiB queued socket bytes, 128 queued socket events
and 128 timers. Guest deadlines can expire first. Disposal aborts requests,
closes sockets, clears timers, revokes Blob URLs and terminates compiler workers.

The web ponyfills and compiler are example-only development dependencies. They
are not embedded in the engine WASM or added to the published package's runtime
dependencies. Upstream references: [Fetch Standard](https://fetch.spec.whatwg.org/),
[WebSockets Standard](https://websockets.spec.whatwg.org/), and
[Node Fetch](https://nodejs.org/api/globals.html#fetch).
