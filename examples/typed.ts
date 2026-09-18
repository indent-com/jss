import { createSandbox, evaluate, type Handle, type SandboxOptions } from '@indent-com/jss';

const options: SandboxOptions = { execution: 'worker', timeoutMs: 1_000 };
const answer: number = await evaluate<number>('6 * 7', options);
const sandbox = await createSandbox(options);
try {
  const object: Handle = await sandbox.handle({ answer });
  try {
    const copied = await object.dump<{ answer: number }>();
    console.log(copied.answer);
  } finally { await object.dispose(); }
} finally { await sandbox.dispose(); }
