import { evaluate, withSandbox } from '@indent-com/jss';

console.log('One-shot:', await evaluate('6 * 7'));

const greeting = await withSandbox({ globals: { userId: 'ada' } }, async sandbox => {
  await sandbox.expose('lookup', async id => ({ id, name: 'Ada' }));
  return sandbox.evaluate(`
    const person = await lookup(userId);
    'Hello, ' + person.name
  `);
});
console.log(greeting);
