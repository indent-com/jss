import { createSandbox } from '@indent-com/jss';

await using sandbox = await createSandbox();
{
  await using counter = await sandbox.evaluateHandle('({ value: 40, add(n) { this.value += n; return this.value } })');
  await using result = await counter.invoke('add', [2]);
  console.log('Counter:', await result.dump());
}

await using echo = await sandbox.createFunction(async (_receiver, args) => args[0]);
await sandbox.set('echo', echo);
console.log('Host callback:', await sandbox.evaluate('await echo({ answer: 42 })'));
