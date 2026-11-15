import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withSandbox } from '../dist/node.js';

// The guest must not see the host's zone or locale.
process.env.TZ = 'America/New_York';
const time = Date.UTC(2026, 10, 5, 22, 41, 52);

for (const execution of ['inline', 'worker']) {
  const check = (name, fn) => test(`${execution}: ${name}`, { timeout: 20_000 }, fn);

  check('Intl is absent unless enabled', async () => {
    await withSandbox({ execution }, async (sandbox) => {
      assert.equal(await sandbox.evaluate('typeof Intl'), 'undefined');
    });
  });

  check('intl formats with the host Intl, defaulting to en-US and UTC', async () => {
    await withSandbox({ execution, intl: true }, async (sandbox) => {
      await sandbox.set('time', time);
      assert.deepEqual(await sandbox.evaluate(`[
        new Date(time).toLocaleString(),
        new Date(time).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
        new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'Asia/Tokyo' }).format(time),
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        (1234567.5).toLocaleString(),
        new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(12.5),
        [3, 1, 2].map(new Intl.NumberFormat().format).join(' '),
        ['b', 'ä', 'a'].sort(new Intl.Collator('de').compare).join(''),
        [...new Intl.Segmenter('en', { granularity: 'word' }).segment('hi there')].map(s => s.segment),
        new Intl.Locale('en').maximize().toString(),
      ]`), [
        '11/5/2026, 10:41:52 PM',
        '11/5/2026, 2:41:52 PM',
        '6. November 2026',
        'UTC',
        '1,234,567.5',
        '12,50\u00a0€',
        '3 1 2',
        'aäb',
        ['hi', ' ', 'there'],
        'en-Latn-US',
      ]);
      assert.deepEqual(await sandbox.evaluate(`[
        (() => { try { new Intl.DateTimeFormat('en', { timeZone: 'Nowhere/Zone' }); } catch (e) { return e instanceof RangeError; } })(),
        (() => { try { Intl.NumberFormat.prototype.format; } catch (e) { return e instanceof TypeError; } })(),
      ]`), [true, true]);
    });
  });
}
