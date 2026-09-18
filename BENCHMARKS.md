# Benchmarks

Measured 2026-09-18T05:12:00.381Z. These are steady-state, end-to-end costs of the shipped
JSS API against native QuickJS-NG and Node.js, on this machine. They are not a
claim that engine differences are binding overhead. Lower is better.

## Results

Median **microseconds per operation** across 9 measured batches.
For compute, JSON and guest scan, an operation is the complete workload described
below; for asynchronous rows, it is one awaited operation. Copy round-trip rows
send and return the indicated payload and read a few changing offsets. The
separate combined row also reads every returned byte in guest JavaScript.

| Workload | Node | Node worker | Native QuickJS | JSS inline | JSS worker |
| --- | ---: | ---: | ---: | ---: | ---: |
| Integer mixing | 13.01 | 13.19 | 973.7 | 684.2 | 676.7 |
| JSON round trip | 7.529 | 7.861 | 43.78 | 81.42 | 82.01 |
| Guest promise | 0.04101 | 0.04727 | 0.5114 | 0.9902 | 1.007 |
| Host → guest call | 0.05235 | 6.477 | 0.2998 | 36.89 | 53.88 |
| Guest → host scalar | 0.03926 | 6.927 | 0.5524 | 48.9 | 63.56 |
| Copy round trip 4 KiB | 1.042 | 12.22 | 1.147 | 95.98 | 116.3 |
| Copy round trip 64 KiB | 14.05 | 45.9 | 3.206 | 145 | 171 |
| Guest scan 64 KiB | 36.63 | 31.38 | 3,229 | 5,404 | 5,393 |
| Round trip + scan 64 KiB | 61.05 | 77.12 | 3,269 | 5,654 | 5,758 |

Multipliers are JSS median time divided by the named baseline; **1× is parity**.
These include VM, allocation, copying, scheduling and API costs. In particular,
JSS/Node compares QuickJS's interpreter with V8's optimizing JIT.

| Workload | Inline / native QJS | Worker / native QJS | Inline / Node | Worker / Node | Worker / Node worker |
| --- | ---: | ---: | ---: | ---: | ---: |
| Integer mixing | 0.7026× | 0.695× | 52.61× | 52.03× | 51.31× |
| JSON round trip | 1.86× | 1.873× | 10.81× | 10.89× | 10.43× |
| Guest promise | 1.936× | 1.969× | 24.15× | 24.56× | 21.3× |
| Host → guest call | 123× | 179.7× | 704.6× | 1,029× | 8.319× |
| Guest → host scalar | 88.53× | 115.1× | 1,246× | 1,619× | 9.175× |
| Copy round trip 4 KiB | 83.67× | 101.4× | 92.09× | 111.6× | 9.514× |
| Copy round trip 64 KiB | 45.23× | 53.33× | 10.32× | 12.17× | 3.725× |
| Guest scan 64 KiB | 1.673× | 1.67× | 147.5× | 147.2× | 171.9× |
| Round trip + scan 64 KiB | 1.73× | 1.762× | 92.63× | 94.33× | 74.67× |

## What is measured

- **Integer mixing:** 10,000 xorshift32 steps.
- **JSON round trip:** create, stringify, parse and consume 32 records.
- **Guest promise:** one await Promise.resolve(number).
- **Host → guest call:** one awaited public function call returning a number.
- **Guest → host scalar:** one awaited host callback with a number.
- **Copy round trip 4 KiB:** one awaited copy callback carrying 4 KiB out and 4 KiB back; consume length and four byte reads.
- **Copy round trip 64 KiB:** one awaited copy callback carrying 64 KiB out and 64 KiB back; consume length and four byte reads.
- **Guest scan 64 KiB:** sum every byte of a prepared guest buffer, without a host callback.
- **Round trip + scan 64 KiB:** one awaited copy callback carrying 64 KiB out and 64 KiB back, then sum every returned byte in guest JavaScript.

Every engine executes the same [workload source](benchmarks/workloads.js).
JSS uses a persistent 64 MiB sandbox and its public `sandbox.call()` API,
including result copying, promise completion and internal result cleanup.
The host→guest row repeats that whole API operation: it is **not one worker hop**.
Other rows amortize one outer call over a batch of guest work.

Before every batch, all five backends call the same untimed `benchPrepare()`.
It allocates and fills byte buffers; for copy workloads it also round-trips one
buffer, verifies every byte and checks that the result has independent storage.
This also warms the copy path and guest code consistently across backends.
Timed copy rows still allocate a fresh returned buffer, check its length and
storage identity, and perform four byte reads, two at offsets that vary per operation.
They do not scan all 65,536 bytes. The guest-scan row sums a prepared buffer without
crossing the host boundary; the combined row includes both copying and a full
guest scan. These rows separate different workloads, rather than subtracting
one noisy measurement from another or claiming to isolate a single internal cost.

Native QuickJS uses the vendored engine, a 64 MiB runtime, 512 KiB stack cap,
30-second deadline, preloaded functions and a C embedding with its job queue.
Its host callbacks return promises settled by a local C queue, without sleeping.
Node calls the same functions directly with async JavaScript host callbacks;
it provides no sandbox boundary. The Node worker control uses `worker_threads`
messages and structured cloning in both directions, with the callback on the
parent. Each byte callback returns a fresh copy in all five backends. Native
QuickJS/C and plain Node do not implement JSS's value codec or isolation contract.
JSS carries bytes as binary attachments across WASM and transfers library-owned
buffers across workers. Caller buffers remain attached and independently owned.

Native protocol pipe I/O is outside its C timer; worker messaging is inside the
Node worker and JSS worker timers. This compares an in-process C embedding with
the public JSS operation, not process-launch latency. Runtime/worker creation,
source loading, compilation, setup, per-batch preparation and final disposal are
excluded everywhere. Preparation can still affect cache warmth and later GC.
There is no disk/network I/O or artificial timer delay in a workload. JSS's own
scheduling remains included. No filesystem, Fetch or WebSocket adapters run here.

Each backend/workload calibrates its own batch size toward 50 ms
(at most 10,000,000 operations), then runs
3 warmup and 9 measured batches. Counts
differ to keep fast baselines measurable without making slow callbacks take
minutes. Inputs cycle through a fixed 32-value pool so larger batches do not
change the per-operation data range. Timers are monotonic. Every batch checksum is compared with an untimed
Node reference; all matched. Backend order rotates between rounds; runs are
serial. There is no forced GC, outlier deletion or empty-loop subtraction.
Calibration and warmup are excluded. V8 JIT, normal GC, CPU frequency changes
and OS scheduling still affect results; ranges are observations, not confidence
intervals or stable tail-latency estimates. This is one run on one host, not a
cross-platform performance claim. There is no same-WASM lower-level baseline,
so these numbers cannot isolate the TypeScript binding's cost from WASM itself.

## Environment

- CPU: 13th Gen Intel(R) Core(TM) i5-13500; 20 logical CPUs; 62.58 GiB RAM.
- OS: linux x64; kernel 6.18.48.
- Affinity: 2,4; governor: powersave.
- Load average (1/5/15 min), before → after: 2.33/2.05/1.87 → 1.68/1.92/1.83.
- Node.js 24.19.0; V8 13.6.233.17-node.51.
- QuickJS-NG 0.16.2, commit `1ab8676f4b6d6d669baeb5f21790fb9734636a20`, for both native and WASM.
- Native compiler: 15.2.0; `-O3 -DNDEBUG -funsigned-char`, Nix stdenv defaults, no LTO or `-march=native`.
- WASM: emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 5.0.6-git; shipped size-oriented `-Oz`, no LTO. Optimization settings intentionally represent the shipped WASM versus an optimized native build.
- WASM SHA-256: `4ffee4f798995422fdbda0abd73e203b783286533755e477cb661f2e83421908`.
- Compiled binding JavaScript SHA-256: `1221c4372915b931f8ec0b81401a3c147b915e3a184c019d7263b115876760f7`.

## Reproduce

From the checkout with direnv enabled:

```sh
npm ci --ignore-scripts
npm run build
benchmark
```

The benchmark command builds the native harness through `flake.nix` and writes
this document plus [raw samples and metadata](benchmarks/results.json). It is
manual, outside CI correctness checks, and adds no npm runtime dependency.
On Linux, a caller can use `taskset -c CPU_LIST benchmark` to select CPUs;
the resulting affinity is recorded. This run used 2,4.
Use equally capable cores on hybrid CPUs. It does not fix CPU frequency or
reserve those CPUs against unrelated processes. Re-run to measure another host;
do not compare different machines' ratios as if they were controlled experiments.

## Batch counts and observed spread

Microseconds per operation; every cell includes all 9 samples.

| Workload | Backend | Operations/batch | Min | Median | Max |
| --- | --- | ---: | ---: | ---: | ---: |
| Integer mixing | Node | 3,830 | 12.85 | 13.01 | 13.39 |
| Integer mixing | Node worker | 3,510 | 12.95 | 13.19 | 13.48 |
| Integer mixing | Native QuickJS | 53 | 950.3 | 973.7 | 987 |
| Integer mixing | JSS inline | 70 | 665.3 | 684.2 | 690 |
| Integer mixing | JSS worker | 67 | 665.1 | 676.7 | 701.6 |
| JSON round trip | Node | 6,447 | 7.363 | 7.529 | 7.662 |
| JSON round trip | Node worker | 6,145 | 7.697 | 7.861 | 7.964 |
| JSON round trip | Native QuickJS | 1,131 | 42.44 | 43.78 | 44.34 |
| JSON round trip | JSS inline | 557 | 78.35 | 81.42 | 81.63 |
| JSON round trip | JSS worker | 598 | 80.25 | 82.01 | 82.22 |
| Guest promise | Node | 913,940 | 0.03139 | 0.04101 | 0.04328 |
| Guest promise | Node worker | 900,229 | 0.03445 | 0.04727 | 0.04771 |
| Guest promise | Native QuickJS | 98,444 | 0.4925 | 0.5114 | 0.5144 |
| Guest promise | JSS inline | 36,164 | 0.9721 | 0.9902 | 1.009 |
| Guest promise | JSS worker | 41,330 | 0.9795 | 1.007 | 1.041 |
| Host → guest call | Node | 1,369,532 | 0.03825 | 0.05235 | 0.05323 |
| Host → guest call | Node worker | 6,651 | 6.407 | 6.477 | 6.55 |
| Host → guest call | Native QuickJS | 163,994 | 0.2967 | 0.2998 | 0.3047 |
| Host → guest call | JSS inline | 1,057 | 35.9 | 36.89 | 40.2 |
| Host → guest call | JSS worker | 721 | 50.84 | 53.88 | 72.08 |
| Guest → host scalar | Node | 1,048,576 | 0.034 | 0.03926 | 0.04021 |
| Guest → host scalar | Node worker | 5,992 | 6.572 | 6.927 | 8.055 |
| Guest → host scalar | Native QuickJS | 91,520 | 0.542 | 0.5524 | 0.5673 |
| Guest → host scalar | JSS inline | 991 | 47.42 | 48.9 | 49.13 |
| Guest → host scalar | JSS worker | 723 | 59.57 | 63.56 | 86.89 |
| Copy round trip 4 KiB | Node | 59,528 | 1.027 | 1.042 | 1.069 |
| Copy round trip 4 KiB | Node worker | 3,820 | 11.55 | 12.22 | 12.86 |
| Copy round trip 4 KiB | Native QuickJS | 43,828 | 1.139 | 1.147 | 1.163 |
| Copy round trip 4 KiB | JSS inline | 471 | 94.52 | 95.98 | 101.6 |
| Copy round trip 4 KiB | JSS worker | 416 | 111.2 | 116.3 | 123 |
| Copy round trip 64 KiB | Node | 5,840 | 12.86 | 14.05 | 15.95 |
| Copy round trip 64 KiB | Node worker | 994 | 42.94 | 45.9 | 55.56 |
| Copy round trip 64 KiB | Native QuickJS | 15,677 | 3.087 | 3.206 | 3.236 |
| Copy round trip 64 KiB | JSS inline | 355 | 132.5 | 145 | 174.6 |
| Copy round trip 64 KiB | JSS worker | 256 | 157.3 | 171 | 223.5 |
| Guest scan 64 KiB | Node | 1,365 | 36.36 | 36.63 | 36.84 |
| Guest scan 64 KiB | Node worker | 1,608 | 30.77 | 31.38 | 31.47 |
| Guest scan 64 KiB | Native QuickJS | 16 | 3,159 | 3,229 | 3,248 |
| Guest scan 64 KiB | JSS inline | 9 | 5,316 | 5,404 | 5,475 |
| Guest scan 64 KiB | JSS worker | 9 | 5,293 | 5,393 | 5,473 |
| Round trip + scan 64 KiB | Node | 1,015 | 52.09 | 61.05 | 72.69 |
| Round trip + scan 64 KiB | Node worker | 700 | 74.4 | 77.12 | 82.53 |
| Round trip + scan 64 KiB | Native QuickJS | 16 | 3,172 | 3,269 | 3,306 |
| Round trip + scan 64 KiB | JSS inline | 8 | 5,554 | 5,654 | 5,952 |
| Round trip + scan 64 KiB | JSS worker | 8 | 5,696 | 5,758 | 5,855 |
