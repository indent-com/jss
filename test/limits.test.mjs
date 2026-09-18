import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
for (const execution of ['inline', 'worker']) {
  for (const scenario of ['loop', 'jobs', 'proxy', 'pending', 'memory', 'stack', 'late-callback', 'jobs-abort', 'calls-yield', 'background-jobs', 'idle-callback', ...(execution === 'worker' ? ['abort', 'responsive'] : [])]) {
    test(`${execution}: ${scenario} survives external watchdog`, { timeout: 20_000 }, async () => {
      const { stdout } = await execute(process.execPath, [new URL('./watchdog.mjs', import.meta.url).pathname, scenario, execution], {
        timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), { scenario, execution, ok: true });
    });
  }
}
