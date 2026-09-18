# JSS vs OpenCode 2 Code Mode vs Executor

Sandboxed-JavaScript comparison measured 2026-09-18 on one host. All three run
untrusted JavaScript with a host boundary, but only JSS is a library you embed;
the other two are agent harness code-execution tools whose boundary is an RPC.

Every number below is a median of 9 measured batches of the **same** workload
source ([`benchmarks/workloads.js`](benchmarks/workloads.js)), µs per operation,
lower better. All 72 sandbox batches were checksum-verified against an untimed
Node reference: **36/36 Code Mode, 36/36 Executor, all matched**.

## The three runtimes

| | JSS 0.1.0 | OpenCode 2 Code Mode | Executor 1.6.8 |
| --- | --- | --- | --- |
| Engine | QuickJS-NG in WASM (vendored, `-Oz`) | undisclosed restricted interpreter | undisclosed; perf profile is QuickJS-class |
| Shape | npm library, in-process or Worker | `execute` tool in the agent harness | `execute` MCP tool, local daemon |
| Boundary | `sandbox.expose()` host functions, handles | `tools` object + `fetch` | `tools()` + `fetch` |
| Language | full ES2023 | ES subset | TypeScript accepted |
| Caller controls limits | yes: memory, stack, timeout | no | no |

## Guest execution cost (µs/op, median of 9; batch size in parens)

| Workload | JSS inline | JSS worker | Executor | OC2 Code Mode | Node (V8, no sandbox) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Integer mixing, 10k xorshift32 | **671.9** (747) | 666.3 (736) | 1,156 (430) | 76,000 (7) | 13.22 (38,079) |
| JSON round trip, 32 records | **79.94** (6,322) | 79.34 (6,345) | 89.65 (5,611) | 978.9 (475) | 7.418 (65,536) |
| Guest promise, one `await` | **0.9715** (482,015) | 1.014 (511,005) | 1.083 (436,907) | 14.66 (31,508) | 0.03525 (10M) |
| Guest scan 64 KiB | **5,496** (98) | 5,411 (93) | 5,744 (86) | 296,500 (2) | 30.85 (16,674) |

Ratios; **1× is parity with JSS inline**.

| Workload | Executor / JSS | Code Mode / JSS | Code Mode / Executor | Executor / Node |
| --- | ---: | ---: | ---: | ---: |
| Integer mixing | 1.72× | 113× | 65.8× | 87.4× |
| JSON round trip | 1.12× | 12.3× | 10.9× | 12.1× |
| Guest promise | 1.11× | 15.1× | 13.5× | 30.7× |
| Guest scan 64 KiB | 1.05× | 54.0× | 51.6× | 186× |

Run-to-run spread is tight everywhere (Executor ±1.5%, Code Mode ±2%), so the
orderings are not noise.

## Boundary cost (µs per crossing)

Not like-for-like — three different mechanisms — but this is what leaving each
sandbox actually costs.

| Crossing | µs |
| --- | ---: |
| Node direct async call (no boundary, floor) | 0.0346 |
| Node `worker_threads` postMessage round trip | 7.603 |
| **JSS inline** host callback (codec + promise + cleanup) | **49.15** |
| **JSS worker** host callback | **64.91** |
| `node:http` keep-alive localhost round trip (protocol floor) | 69.2 |
| **OC2 Code Mode** `fetch` to localhost | **1,040** |
| Node global `fetch` (undici) to the same server | 1,706 |
| **Executor** one whole `execute` MCP operation, trivial code | **2,878** (2,164–5,813) |

## Reading it

- **Executor and JSS are peers for guest compute.** Executor is within 1.05–1.12×
  of JSS on JSON, promises and byte scanning, and 1.72× slower only on the tight
  integer loop. Both are interpreters: 12–186× off V8 on identical code.
- **Code Mode is in a different class: 12–113× slower than JSS.** The spread is
  the tell. Its worst case (113×) is pure bytecode dispatch; its best case (12×,
  JSON) is where native builtins do the work. That is the signature of a slow
  interpreter loop, not a slow engine overall.
- **The gap tracks interpretation, not isolation.** JSS `inline` vs `worker`
  differs by 0.7–4% on these rows, because a batch amortizes one crossing over
  many guest ops. Isolation is cheap; interpreting is not.
- **Boundary economics differ by three orders of magnitude.** A JSS host callback
  is 49 µs — cheaper than a localhost TCP round trip. Executor's cheapest unit of
  work is a 2.9 ms MCP round trip, ~59× a JSS callback. Code Mode has no
  in-process host function at all; its cheapest escape hatch is a 1 ms `fetch`.
  So JSS suits chatty host interaction; the harness tools suit one coarse call.
- **Capability is the sharpest difference, not speed.** Code Mode lacks
  `globalThis`, `eval`, `ArrayBuffer` (its `Uint8Array` has no `.buffer`),
  `BigInt`, `Proxy`, `Reflect` and `performance`; timing is `Date.now()` at 1 ms.
  Executor has all of those. JSS gives full ES2023 plus caller-set memory, stack
  and timeout limits. Porting the workload needed no change for Executor, and
  only the removal of three `globalThis.` assignments for Code Mode.

## Method and caveats

Protocol mirrors [`benchmarks/run.mjs`](benchmarks/run.mjs): each backend
calibrates its own batch toward 500 ms, then 3 warmup and 9 measured batches on
the identical seed schedule (`0x123500 + round * 97`); median µs/op; untimed
preparation; no forced GC, outlier removal or empty-loop subtraction. 500 ms
batches (not the repo's 50 ms) because both sandboxes can only time with 1 ms
`Date.now()`; at 500 ms quantization is ~0.2%. Control: JSS and Node measured
here at 500 ms match the repo's published 50 ms run within 2% (JSS inline
compute 671.9 vs 684.2; JSON 79.94 vs 81.42; promise 0.9715 vs 0.9902; scan
5,496 vs 5,404), so batch length is not driving the comparison.

Only the four workloads needing no host callback are compared. The copy
round-trip rows are excluded: neither harness tool exposes a comparable
in-process host function, and Code Mode has no `ArrayBuffer` identity to check.

Both sandbox runtimes were confirmed to execute on this same host — from inside
each, `fetch('http://127.0.0.1:…')` reached a local server that reported
`indentbox` / i5-13500 — so this is not a cross-machine comparison.

Caveats: one run, one host, load average ~1.9 of 20 logical CPUs, no CPU pinning
or frequency fixing. Engine identity for Code Mode and Executor is inferred from
behaviour and performance, not confirmed; neither exposes a version from inside.
Both are moving targets, so these are measurements of what they were today, and
ratios from another machine should not be compared with these.

Environment: 13th Gen Intel Core i5-13500, 20 logical CPUs, Linux x64 kernel
6.18.48; Node.js 24.19.0, V8 13.6.233.17-node.51; JSS 0.1.0 from `dist/` with a
64 MiB sandbox, 512 KiB stack cap and 30 s deadline; Executor 1.6.8 over MCP
stdio with a warm daemon.
