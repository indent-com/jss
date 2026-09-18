import { withSandbox } from '@indent-com/jss';

await withSandbox({}, async sandbox => {
  const counter = await sandbox.evaluateHandle('({ value: 40, add(n) { this.value += n; return this.value } })');
  try {
    const result = await counter.invoke('add', [2]);
    try { console.log('Counter:', await result.dump()); }
    finally { await result.dispose(); }
  } finally { await counter.dispose(); }

  const echo = await sandbox.createFunction(async (_receiver, args) => args[0]);
  try {
    await sandbox.set('echo', echo);
    console.log('Host callback:', await sandbox.evaluate('await echo({ answer: 42 })'));
  } finally { await echo.dispose(); }
});
