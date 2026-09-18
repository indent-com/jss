import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, platform, arch, release, loadavg, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { nodeDriver, nodeWorkerDriver, jssDriver, quickjsDriver } from './drivers.mjs';

if (process.argv.length > 2) {
  console.log('Usage: benchmark\nBuild dist first with npm run build. Results replace BENCHMARKS.md and benchmarks/results.json.');
  process.exit(process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2]) ? 0 : 2);
}
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const source = await readFile('benchmarks/workloads.js', 'utf8');
const targetMs = 50, warmups = 3, rounds = 9, maxCount = 10_000_000;
const cases = [
  ['compute', 'Integer mixing', '10,000 xorshift32 steps'],
  ['json', 'JSON round trip', 'create, stringify, parse and consume 32 records'],
  ['promise', 'Guest promise', 'one await Promise.resolve(number)'],
  ['call', 'Host → guest call', 'one awaited public function call returning a number'],
  ['host-scalar', 'Guest → host scalar', 'one awaited host callback with a number'],
  ['host-copy-4k', 'Copy round trip 4 KiB', 'one awaited copy callback carrying 4 KiB out and 4 KiB back; consume length and four byte reads'],
  ['host-copy-64k', 'Copy round trip 64 KiB', 'one awaited copy callback carrying 64 KiB out and 64 KiB back; consume length and four byte reads'],
  ['guest-scan-64k', 'Guest scan 64 KiB', 'sum every byte of a prepared guest buffer, without a host callback'],
  ['host-bytes-64k', 'Round trip + scan 64 KiB', 'one awaited copy callback carrying 64 KiB out and 64 KiB back, then sum every returned byte in guest JavaScript'],
].map(([id, name, operation]) => ({ id, name, operation }));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const optional = async path => { try { return (await readFile(path, 'utf8')).trim(); } catch { return null; } };
const snapshot = {
  timestamp: new Date().toISOString(), platform: platform(), arch: arch(), kernel: release(),
  cpu: cpus()[0].model, logicalCPUs: cpus().length, memoryGiB: totalmem() / 2 ** 30,
  node: process.versions.node, v8: process.versions.v8, loadStart: loadavg(),
  cpuAffinity: (await optional('/proc/self/status'))?.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1] ?? null,
  governor: await optional('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
  wasmSHA256: sha256(await readFile('dist/engine/quickjs.wasm')),
  wasmBuild: JSON.parse(await readFile('dist/engine/build.json', 'utf8')),
  workloadsSHA256: sha256(source),
  bindingsSHA256: sha256(await Promise.all(['engine', 'core', 'codec', 'transport'].map(async name => `${name}\n${await readFile(`dist/${name}.js`, 'utf8')}`)).then(parts => parts.join('\n'))),
};
// A path flake includes newly added files without requiring changes to Git's index.
const nativeOutput = execFileSync('nix', ['build', `path:${root}#benchmark-native`, '--no-link', '--print-out-paths', '--no-update-lock-file'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
}).trim();
const nativeBinary = `${nativeOutput}/bin/jss-benchmark-native`;
snapshot.nativeBinarySHA256 = sha256(await readFile(nativeBinary));

const drivers = [], results = [];
try {
  drivers.push(nodeDriver(source));
  drivers.push(await nodeWorkerDriver(source));
  drivers.push(await quickjsDriver(nativeBinary, `${root}benchmarks/workloads.js`));
  drivers.push(await jssDriver('inline', source));
  drivers.push(await jssDriver('worker', source));
  snapshot.native = drivers.find(driver => driver.id === 'quickjs').metadata;

  // Cross-engine checks are outside measurement; no logging or reference work
  // occurs inside a timed batch. Source is deterministic and every result used.
  const expected = new Map();
  async function reference(name, count, seed) {
    const key = `${name}:${count}:${seed}`;
    if (!expected.has(key)) {
      await benchPrepare(name, count, seed);
      const value = name === 'call'
        ? Number((BigInt(count) * BigInt(seed) + BigInt(Math.floor(count / 32)) * 496n + BigInt(count % 32) * BigInt((count % 32) - 1) / 2n) & 0xffffffffn)
        : await benchRun(name, count, seed);
      expected.set(key, value);
    }
    return expected.get(key);
  }
  async function sample(driver, name, count, seed) {
    const correct = await reference(name, count, seed);
    const value = await driver.run(name, count, seed);
    assert.equal(value.checksum, correct, `${driver.name}: ${name}, n=${count}, seed=${seed}`);
    assert.ok(Number.isFinite(value.milliseconds) && value.milliseconds > 0, 'Invalid timer result');
    return { ...value, seed, microsecondsPerOperation: value.milliseconds * 1000 / count };
  }
  async function calibrate(driver, name) {
    let count = 1;
    for (let attempt = 0; attempt < 9; attempt++) {
      const { milliseconds } = await sample(driver, name, count, 0x123456);
      if (milliseconds >= targetMs * 0.8 || count === maxCount) return count;
      count = Math.min(maxCount, Math.max(count + 1, Math.min(count * 16, Math.ceil(count * targetMs / milliseconds))));
    }
    return count;
  }
  for (const workload of cases) {
    console.error(`Benchmarking ${workload.name}…`);
    const entries = [];
    for (const driver of drivers) {
      const count = await calibrate(driver, workload.id);
      entries.push({ driver: driver.id, count, samples: [] });
    }
    for (const entry of entries) {
      for (let i = 0; i < warmups; i++) await reference(workload.id, entry.count, 0x123456 + i);
      for (let round = 0; round < rounds; round++) await reference(workload.id, entry.count, 0x123500 + round * 97);
    }
    for (let index = 0; index < drivers.length; index++) {
      for (let i = 0; i < warmups; i++) await sample(drivers[index], workload.id, entries[index].count, 0x123456 + i);
    }
    // Rotate backend order each round to reduce systematic drift. Never run
    // engines in parallel, force GC, or subtract an estimated empty-loop cost.
    for (let round = 0; round < rounds; round++) {
      for (let offset = 0; offset < drivers.length; offset++) {
        const index = (round + offset) % drivers.length;
        const entry = entries[index];
        entry.samples.push(await sample(drivers[index], workload.id, entry.count, 0x123500 + round * 97));
      }
    }
    for (const entry of entries) {
      const sorted = entry.samples.map(sample => sample.microsecondsPerOperation).sort((a, b) => a - b);
      entry.median = sorted[Math.floor(sorted.length / 2)];
      entry.min = sorted[0]; entry.max = sorted.at(-1);
    }
    results.push({ ...workload, entries });
  }
  snapshot.loadEnd = loadavg();
  const data = { environment: snapshot, configuration: { targetMs, warmups, rounds, maxCount }, backends: drivers.map(({ id, name }) => ({ id, name })), results };
  await writeFile('benchmarks/results.json', JSON.stringify(data, null, 2) + '\n');
  await writeFile('BENCHMARKS.md', report(data));
  console.error('Wrote BENCHMARKS.md and benchmarks/results.json (all checksums matched).');
} finally {
  for (const driver of drivers.reverse()) await driver.dispose();
}

function report({ environment: env, configuration, backends, results }) {
  const number = value => value.toLocaleString('en-US', { maximumSignificantDigits: 4 });
  const cell = (row, backend) => row.entries.find(entry => entry.driver === backend);
  const ratio = (row, numerator, denominator) => number(cell(row, numerator).median / cell(row, denominator).median) + '×';
  const costs = results.map(row => `| ${row.name} | ${backends.map(backend => number(cell(row, backend.id).median)).join(' | ')} |`).join('\n');
  const ratios = results.map(row => `| ${row.name} | ${ratio(row, 'jss-inline', 'quickjs')} | ${ratio(row, 'jss-worker', 'quickjs')} | ${ratio(row, 'jss-inline', 'node')} | ${ratio(row, 'jss-worker', 'node')} | ${ratio(row, 'jss-worker', 'node-worker')} |`).join('\n');
  const details = results.flatMap(row => backends.map(backend => {
    const entry = cell(row, backend.id);
    return `| ${row.name} | ${backend.name} | ${entry.count.toLocaleString('en-US')} | ${number(entry.min)} | ${number(entry.median)} | ${number(entry.max)} |`;
  })).join('\n');
  return `# Benchmarks

Measured ${env.timestamp}. These are steady-state, end-to-end costs of the shipped
JSS API against native QuickJS-NG and Node.js, on this machine. They are not a
claim that engine differences are binding overhead. Lower is better.

## Results

Median **microseconds per operation** across ${configuration.rounds} measured batches.
For compute, JSON and guest scan, an operation is the complete workload described
below; for asynchronous rows, it is one awaited operation. Copy round-trip rows
send and return the indicated payload and read a few changing offsets. The
separate combined row also reads every returned byte in guest JavaScript.

| Workload | ${backends.map(backend => backend.name).join(' | ')} |
| --- | ${backends.map(() => '---:').join(' | ')} |
${costs}

Multipliers are JSS median time divided by the named baseline; **1× is parity**.
These include VM, allocation, copying, scheduling and API costs. In particular,
JSS/Node compares QuickJS's interpreter with V8's optimizing JIT.

| Workload | Inline / native QJS | Worker / native QJS | Inline / Node | Worker / Node | Worker / Node worker |
| --- | ---: | ---: | ---: | ---: | ---: |
${ratios}

## What is measured

${results.map(row => `- **${row.name}:** ${row.operation}.`).join('\n')}

Every engine executes the same [workload source](benchmarks/workloads.js).
JSS uses a persistent 64 MiB sandbox and its public \`sandbox.call()\` API,
including result copying, promise completion and internal result cleanup.
The host→guest row repeats that whole API operation: it is **not one worker hop**.
Other rows amortize one outer call over a batch of guest work.

Before every batch, all five backends call the same untimed \`benchPrepare()\`.
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
it provides no sandbox boundary. The Node worker control uses \`worker_threads\`
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

Each backend/workload calibrates its own batch size toward ${configuration.targetMs} ms
(at most ${configuration.maxCount.toLocaleString('en-US')} operations), then runs
${configuration.warmups} warmup and ${configuration.rounds} measured batches. Counts
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

- CPU: ${env.cpu}; ${env.logicalCPUs} logical CPUs; ${number(env.memoryGiB)} GiB RAM.
- OS: ${env.platform} ${env.arch}; kernel ${env.kernel}.
- Affinity: ${env.cpuAffinity ?? 'not recorded'}; governor: ${env.governor ?? 'not recorded'}.
- Load average (1/5/15 min), before → after: ${env.loadStart.map(number).join('/')} → ${env.loadEnd.map(number).join('/')}.
- Node.js ${env.node}; V8 ${env.v8}.
- QuickJS-NG ${env.wasmBuild.version}, commit \`${env.wasmBuild.commit}\`, for both native and WASM.
- Native compiler: ${env.native.compiler}; \`-O3 -DNDEBUG -funsigned-char\`, Nix stdenv defaults, no LTO or \`-march=native\`.
- WASM: ${env.wasmBuild.emscripten}; shipped size-oriented \`-Oz\`, no LTO. Optimization settings intentionally represent the shipped WASM versus an optimized native build.
- WASM SHA-256: \`${env.wasmSHA256}\`.
- Compiled binding JavaScript SHA-256: \`${env.bindingsSHA256}\`.

## Reproduce

From the checkout with direnv enabled:

\`\`\`sh
npm ci --ignore-scripts
npm run build
benchmark
\`\`\`

The benchmark command builds the native harness through \`flake.nix\` and writes
this document plus [raw samples and metadata](benchmarks/results.json). It is
manual, outside CI correctness checks, and adds no npm runtime dependency.
On Linux, a caller can use \`taskset -c CPU_LIST benchmark\` to select CPUs;
the resulting affinity is recorded. This run used ${env.cpuAffinity ?? 'the default affinity'}.
Use equally capable cores on hybrid CPUs. It does not fix CPU frequency or
reserve those CPUs against unrelated processes. Re-run to measure another host;
do not compare different machines' ratios as if they were controlled experiments.

## Batch counts and observed spread

Microseconds per operation; every cell includes all ${configuration.rounds} samples.

| Workload | Backend | Operations/batch | Min | Median | Max |
| --- | --- | ---: | ---: | ---: | ---: |
${details}
`;
}
