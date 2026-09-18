import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '@indent-com/jss';
import { createInterface } from 'node:readline';
import { inspect } from 'node:util';
import { installCapabilities } from './capabilities/host.mjs';
import { createModuleLoader } from './capabilities/modules.mjs';

/** Type-check first, then execute a guest module with explicitly granted capabilities. */
export async function createRunner({ root, allowedOrigins = [], args = [], timeoutMs = 15_000, execution = 'worker', console: logger = console }) {
  if (typeof root !== 'string') throw new TypeError('A filesystem root is required');
  const sandbox = await createSandbox({ execution, timeoutMs, memoryLimitBytes: 128 * 1024 * 1024, globals: { args } });
  let capabilities, modules;
  const history = [];
  async function dispose() {
    try { await modules?.dispose(); }
    finally { try { await capabilities?.dispose(); } finally { await sandbox.dispose(); } }
  }
  try {
    capabilities = await installCapabilities(sandbox, { root, allowedOrigins, console: logger });
    modules = await createModuleLoader({ sandbox, filesystem: capabilities.filesystem, allowedOrigins });
    return {
      get disposed() { return sandbox.disposed; },
      async run(entry) {
        const name = await modules.load(entry);
        const namespace = await sandbox.evaluateModuleHandle(name, { timeoutMs });
        try {
          const result = await namespace.get('result');
          try { return await result.dump(); } finally { await result.dispose(); }
        } finally { await namespace.dispose(); }
      },
      async evaluate(source) {
        const { code } = await modules.prepareRepl(source, history);
        // A runtime error can leave declarations and side effects behind.
        // Keep their types in the session; .clear creates a fresh realm.
        history.push(source);
        return sandbox.evaluate(code, { filename: 'jss:/__repl__.ts', timeoutMs });
      },
      dispose,
    };
  } catch (error) { await dispose(); throw error; }
}

export async function runScript(options) {
  const runner = await createRunner(options);
  try { return await runner.run(options.entry); } finally { await runner.dispose(); }
}

async function repl(options) {
  let runner = await createRunner(options);
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let buffer;
  const prompt = () => { if (process.stdin.isTTY) { lines.setPrompt(buffer ? '...> ' : 'jss> '); lines.prompt(); } };
  if (process.stdin.isTTY) console.log('TypeScript QuickJS REPL. .help for commands.');
  prompt();
  try {
    for await (const line of lines) {
      const command = line.trim();
      if (command === '.exit') break;
      if (command === '.help') console.log('.editor: multiline input; .end: evaluate; .break: discard input; .clear: new realm; .exit: quit');
      else if (command === '.clear') { await runner.dispose(); runner = await createRunner(options); buffer = undefined; }
      else if (command === '.break') buffer = undefined;
      else if (command === '.editor') buffer = [];
      else if (buffer && command !== '.end') buffer.push(line);
      else if (command || buffer) {
        const source = buffer ? buffer.join('\n') : line;
        buffer = undefined;
        try {
          const result = await runner.evaluate(source);
          if (result !== undefined) console.log(inspect(result, { colors: Boolean(process.stdout.isTTY), depth: 6 }));
        } catch (error) {
          console.error(error.message);
          if (runner.disposed) console.error('The sandbox has been retired; use .clear for a new realm.');
        }
      }
      prompt();
    }
  } finally { lines.close(); await runner.dispose(); }
}

async function main(argv) {
  const allowedOrigins = [], args = [];
  let root, entry, interactive = false, timeoutMs = 15_000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log('Usage: node examples/runner.mjs --root DIR [--allow-origin URL] [--timeout MS] (ENTRY.ts | --repl) [-- script arguments]');
      return;
    }
    if (arg === '--') { args.push(...argv.slice(i + 1)); break; }
    if (arg === '--repl') { interactive = true; continue; }
    if (arg === '--root' || arg === '--allow-origin' || arg === '--timeout') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--root') root = resolve(value);
      else if (arg === '--allow-origin') allowedOrigins.push(value);
      else timeoutMs = Number(value);
    } else if (arg.startsWith('-') || entry !== undefined) throw new Error(`Unexpected argument: ${arg}`);
    else entry = arg;
  }
  if (!root || (!entry && !interactive) || (entry && interactive)) throw new Error('Supply --root DIR and either an entry module or --repl; see --help');
  if (interactive) return repl({ root, allowedOrigins, args, timeoutMs });
  const result = await runScript({ root, entry, allowedOrigins, args, timeoutMs });
  if (result !== undefined) console.log(result);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
