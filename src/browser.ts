import { createAPI } from './core.js';
import { loadWasm, normalizeUrl } from './browser-assets.js';
export { Sandbox, Handle, SandboxError } from './core.js';
export type { SandboxOptions, ExecutionOptions, ModuleOptions, HostFunction, HandleFunction, GuestType, PropertyKey } from './core.js';
const api = createAPI({
  spawn: () => new Worker(new URL('./browser-worker.js', import.meta.url), { type: 'module' }),
  loadWasm, normalizeUrl,
});
export const { createSandbox, evaluate, withSandbox } = api;
