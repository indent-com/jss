import {
  createSandbox, evaluate, withSandbox, Sandbox, SandboxError,
  type Handle, type SandboxOptions, type ExecutionOptions, type ModuleOptions, type HandleFunction,
} from '@indent-com/jss';
import { evaluate as browserEvaluate } from '@indent-com/jss/browser';

const settings: SandboxOptions = { execution: 'worker', memoryLimitBytes: 8 * 1024 * 1024, timeoutMs: 1_000 };
const execution: ExecutionOptions = { filename: 'typed.js', signal: new AbortController().signal };
const answer: number = await evaluate<number>('42', { ...settings, ...execution });
const browserAnswer: Promise<number> = browserEvaluate<number>('42', { execution: 'inline' });
await using sandbox = await createSandbox(settings);
await using handle: Handle = await sandbox.handle({ answer });
const copied: { answer: number } = await handle.dump<{ answer: number }>();
const callback: HandleFunction = async (receiver, args) => {
  const category: string = await receiver.type();
  return category === 'object' ? args[0] : null;
};
await using functionHandle: Handle = await sandbox.createFunction(callback);
const moduleOptions: ModuleOptions = { timeoutMs: 1_000, signal: execution.signal };
await sandbox.defineModule('/typed.js', 'export const answer = 42;', moduleOptions);
await using namespace: Handle = await sandbox.evaluateModuleHandle('/typed.js', moduleOptions);
const moduleResult: { answer: number } = await sandbox.evaluateModule<{ answer: number }>('/typed.js', moduleOptions);
const scoped: string = await withSandbox({}, async realm => realm.evaluate<string>('"hello"'));
const error: SandboxError = new SandboxError('message');
const code: string = error.code;
void [browserAnswer, copied, scoped, code, moduleResult];

// Internal transport/reference methods must not leak into consumer declarations.
// @ts-expect-error private command transport is not public
sandbox._request('global');
// @ts-expect-error private handle encoding is not public
handle._input(sandbox);
// @ts-expect-error private lifecycle method is not public
handle._invalidate();
// @ts-expect-error internal adapter construction is not public
Sandbox._create({}, {});
// @ts-expect-error handles are asynchronous
const synchronous: number = handle.dump<number>();
// @ts-expect-error unsupported execution modes are rejected statically
const invalid: SandboxOptions = { execution: 'thread' };
void [synchronous, invalid];
