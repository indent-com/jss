import { evaluate, createSandbox } from '@indent-com/jss';

console.log('One-shot:', await evaluate('6 * 7'));

await using sandbox = await createSandbox({ globals: { userId: 'ada' } });
await sandbox.expose('lookup', async id => ({ id, name: 'Ada' }));
const greeting = await sandbox.evaluate(`
  const person = await lookup(userId);
  'Hello, ' + person.name
`);
console.log(greeting);
