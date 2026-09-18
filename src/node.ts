import { Worker } from 'node:worker_threads';
import { createAPI } from './core.js';
import { loadWasm, normalizeUrl } from './node-assets.js';
export { Sandbox, Handle, SandboxError } from './core.js';
export type { SandboxOptions, ExecutionOptions, ModuleOptions, HostFunction, HandleFunction, GuestType, PropertyKey } from './core.js';
const api = createAPI({
  spawn: () => new Worker(new URL('./node-worker.js', import.meta.url), {
    // The entry is already JS. Application loaders, test-runner flags and
    // stdin-only options must not be replayed in the library's worker.
    execArgv: [],
  }),
  loadWasm, normalizeUrl,
});
export const { createSandbox, evaluate, withSandbox } = api;
