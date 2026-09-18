import { createSandbox, evaluate, type Handle, type SandboxOptions } from '@indent-com/jss';

const options: SandboxOptions = { execution: 'worker', timeoutMs: 1_000 };
const answer: number = await evaluate<number>('6 * 7', options);
await using sandbox = await createSandbox(options);
await using object: Handle = await sandbox.handle({ answer });
const copied = await object.dump<{ answer: number }>();
console.log(copied.answer);
