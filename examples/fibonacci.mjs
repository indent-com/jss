import { withSandbox } from '@indent-com/jss';

const input = process.argv[2] ?? '100';
if (!/^\d+$/.test(input) || Number(input) > 10_000) {
  throw new RangeError('Usage: node examples/fibonacci.mjs [integer from 0 to 10000]');
}

const answer = await withSandbox({ globals: { n: Number(input) } }, sandbox =>
  sandbox.evaluate(`
    function fibonacci(n) {
      let a = 0n, b = 1n;
      for (let i = 0; i < n; i++) [a, b] = [b, a + b];
      return a;
    }
    fibonacci(n)
  `),
);
console.log(`fibonacci(${input}) = ${answer}`);
