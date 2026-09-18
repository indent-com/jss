import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir } from 'node:fs/promises';
import { runDemo, createDemoServer } from './capabilities.mjs';
import { runScript, createRunner } from './runner.mjs';
import { createFilesystem } from './capabilities/filesystem.mjs';

const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jss-runner-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('TypeScript demo: files, static/dynamic local and HTTP modules, Fetch streams/forms and WebSocket text/binary', { timeout: 90_000 }, async () => {
  const result = await runDemo();
  assert.equal(result.fibonacci, '354224848179261915075');
  assert.equal(result.dynamicFibonacci, '55');
  assert.equal(result.remote, 'Hello, QuickJS, from an HTTP module');
  assert.equal(result.greeting, 'Hello, 世界');
  assert.deepEqual(result.bytes, [0, 127, 255]);
  assert.deepEqual(result.files, ['output/binary.dat', 'output/greeting.txt']);
  assert.equal(result.fileSize, 18);
  assert.equal(result.echoed, 'A request from QuickJS');
  assert.equal(result.streamedText, 'streaming response 🌍');
  assert.deepEqual(result.uploaded, { message: 'Hello', fileName: 'world.txt', fileText: '🌍' });
  assert.deepEqual(result.messages, ['Hello over WebSocket', [1, 2, 3]]);
});

test('filesystem enforces root, symlinks, Unicode bounds and byte operations', async t => {
  const root = await fixture(t);
  const { handlers: h } = await createFilesystem(root);
  await h['fs.writeText']('unicode.txt', 'A🌍界Z');
  assert.equal(await h['fs.readText']('unicode.txt', { maxChars: 2 }), 'A🌍');
  assert.equal(await h['fs.readText']('unicode.txt', { maxChars: 0 }), '');
  await h['fs.WriteBytes']('bytes', new Uint8Array([0, 255, 128]));
  assert.deepEqual(await h['fs.readBytes']('bytes', { maxBytes: 2 }), new Uint8Array([0, 255]));
  await h['fs.copy']('bytes', 'copy');
  await h['fs.rename']('copy', 'renamed');
  assert.equal((await h['fs.stat']('renamed')).size, 3);
  assert.equal(await h['fs.exists']('absent'), false);
  await assert.rejects(h['fs.readText']('../outside'), /outside/);
  await assert.rejects(h['fs.glob']('../*'), /relative/);
  await symlink(join(root, 'unicode.txt'), join(root, 'link'));
  await assert.rejects(h['fs.readText']('link'), /Symbolic links/);
  await assert.rejects(h['fs.writeText']('link', 'bad'), /Symbolic links/);
  assert.equal(await readFile(join(root, 'unicode.txt'), 'utf8'), 'A🌍界Z');
});

test('type errors reject before execution; unavailable host globals are not advertised', { timeout: 90_000 }, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'bad.ts'), `await fs.writeText('marker', 'must not execute'); const n: number = 'wrong'; export const result = n;`);
  await assert.rejects(runScript({ root, entry: 'bad.ts', console: quiet }), /not assignable|TypeScript/);
  await assert.rejects(readFile(join(root, 'marker')), { code: 'ENOENT' });
  await writeFile(join(root, 'bad.ts'), 'export const result = document.title;');
  await assert.rejects(runScript({ root, entry: 'bad.ts', console: quiet }), /document|TypeScript/);
});

test('computed dynamic TypeScript is checked before execution and HTTP requires permission', { timeout: 90_000 }, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'main.ts'), `const file = './' + args[0]; export const result = await import(file);`);
  await writeFile(join(root, 'bad.ts'), `await fs.writeText('marker', 'must not execute'); export const value: number = 'wrong';`);
  await assert.rejects(runScript({ root, entry: 'main.ts', args: ['bad.ts'], console: quiet }), /not assignable|TypeScript/);
  await assert.rejects(readFile(join(root, 'marker')), { code: 'ENOENT' });
  await writeFile(join(root, 'main.ts'), `import { greeting } from 'https://example.invalid/remote.ts'; export const result = greeting('guest');`);
  await assert.rejects(runScript({ root, entry: 'main.ts', console: quiet }), /origin|allowed|permission/i);
});

test('Fetch body lifecycle, streaming uploads, cancellation, redirects, local URLs and WebSocket validation', { timeout: 90_000 }, async t => {
  const root = await fixture(t);
  const server = await createDemoServer();
  t.after(() => server.dispose());
  await writeFile(join(root, 'main.ts'), `
    const origin = args[0];
    const headers = new Headers([['X-Test', ' one '], ['x-test', 'two'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']]);
    const response = new Response(new Uint8Array([65, 66]), {headers});
    const copied = response.clone();
    const consumed = await response.text();
    let twice = false; try { await response.text(); } catch { twice = true; }
    const copiedBytes = Array.from(await copied.bytes());
    const upload = new ReadableStream<Uint8Array>({start(c) { c.enqueue(new TextEncoder().encode('stream-upload')); c.close(); }});
    const uploaded = await (await fetch(origin+'/echo', {method:'POST', body:upload, duplex:'half'})).text();
    const redirected = await fetch(origin+'/redirect');
    const redirectText = await redirected.text();
    const integrityText = await (await fetch(origin+'/redirect', {integrity:args[1]})).text();
    let redirectDenied = false; try { await fetch(origin+'/redirect-out'); } catch(e) { redirectDenied = /origin|allowed|permitted/i.test((e as Error).message); }
    let abortName = '';
    try { await fetch(origin+'/slow', {signal:AbortSignal.timeout(20)}); } catch (e) { abortName = (e as Error).name; }
    let uploadCancelled = false;
    const pendingUpload = new ReadableStream<Uint8Array>({cancel() { uploadCancelled = true; }});
    const ac = new AbortController();
    const pending = fetch(origin+'/echo', {method:'POST', body:pendingUpload, duplex:'half', signal:ac.signal});
    setTimeout(() => ac.abort(), 20);
    try { await pending; } catch {}
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    const multipart = new FormData(); multipart.set('text', '🌍'); multipart.set('file', new File(['payload'],'a.txt'));
    const parsed = await new Response(multipart).formData();
    const parsedFile = parsed.get('file') as File;
    const dataText = await (await fetch('data:text/plain,hello%20world')).text();
    const blobUrl = URL.createObjectURL(new Blob(['0123456789'], {type:'text/plain'}));
    const rangeResponse = await fetch(blobUrl, {headers:{range:'bytes=2-4'}});
    const rangeText = await rangeResponse.text();
    URL.revokeObjectURL(blobUrl);
    let revoked = false; try { await fetch(blobUrl); } catch { revoked = true; }
    let beforeOpen = '', badCode = '', badReason = '', badProtocols = '';
    try { new WebSocket(origin.replace(/^http/,'ws')+'/socket', ['same','same']); } catch(e) { badProtocols=(e as Error).name; }
    const ws = new WebSocket(origin.replace(/^http/,'ws')+'/socket', ['example']);
    try { ws.send('too soon'); } catch(e) { beforeOpen=(e as Error).name; }
    try { ws.close(2000); } catch(e) { badCode=(e as Error).name; }
    try { ws.close(1000,'🌍'.repeat(32)); } catch(e) { badReason=(e as Error).name; }
    const binary = await new Promise<number[]>((resolve,reject) => {
      ws.binaryType='arraybuffer';
      ws.addEventListener('open', () => ws.send(new Uint8Array([5,6,7])), {once:true});
      ws.addEventListener('error', () => reject(new Error('socket error')), {once:true});
      ws.onmessage=event => { ws.close(1000,'done'); resolve(Array.from(new Uint8Array(event.data))); };
    });
    export const result = {header:headers.get('x-test'),cookies:headers.getSetCookie(),consumed,twice,used:response.bodyUsed,copiedBytes,
      uploaded,redirected:redirected.redirected,redirectText,integrityText,redirectDenied,abortName,uploadCancelled,
      formText:parsed.get('text'),fileText:await parsedFile.text(),dataText,rangeStatus:rangeResponse.status,rangeText,revoked,
      beforeOpen,badCode,badReason,badProtocols,binary};
  `);
  const integrity = 'sha256-' + createHash('sha256').update('streaming response 🌍').digest('base64');
  const result = await runScript({ root, entry: 'main.ts', allowedOrigins: [server.origin], args: [server.origin, integrity], console: quiet });
  assert.equal(result.header, 'one, two');
  assert.deepEqual(result.cookies, ['a=1', 'b=2']);
  assert.equal(result.consumed, 'AB');
  assert.equal(result.twice, true);
  assert.equal(result.used, true);
  assert.deepEqual(result.copiedBytes, [65, 66]);
  assert.equal(result.uploaded, 'stream-upload');
  assert.equal(result.redirected, true);
  assert.equal(result.redirectText, 'streaming response 🌍');
  assert.equal(result.integrityText, 'streaming response 🌍');
  assert.equal(result.redirectDenied, true);
  assert.equal(result.abortName, 'TimeoutError');
  assert.equal(result.uploadCancelled, true);
  assert.equal(result.formText, '🌍');
  assert.equal(result.fileText, 'payload');
  assert.equal(result.dataText, 'hello world');
  assert.equal(result.rangeStatus, 206);
  assert.equal(result.rangeText, '234');
  assert.equal(result.revoked, true);
  assert.deepEqual([result.beforeOpen,result.badCode,result.badReason,result.badProtocols], ['InvalidStateError','InvalidAccessError','SyntaxError','SyntaxError']);
  assert.deepEqual(result.binary, [5,6,7]);
});

test('REPL retains checked declarations across static import, dynamic HTTP import and an assertion', { timeout: 90_000 }, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'math.ts'), 'export function fibonacci(n: number): bigint { let a=0n,b=1n; for(let i=0;i<n;i++) [a,b]=[b,a+b]; return a; }');
  const server = await createDemoServer();
  t.after(() => server.dispose());
  const runner = await createRunner({ root, allowedOrigins: [server.origin], console: quiet });
  t.after(() => runner.dispose());
  assert.equal(await runner.evaluate("import './math.ts'"), undefined);
  assert.equal(await runner.evaluate("import { fibonacci } from './math.ts'"), undefined);
  assert.equal(await runner.evaluate(`const { greeting } = await import('${server.origin}/remote.ts')`), undefined);
  assert.equal(await runner.evaluate("if (fibonacci(10) !== 55n) throw new Error('Fibonacci test failed')"), undefined);
  assert.equal(await runner.evaluate("greeting('QuickJS')"), 'Hello, QuickJS, from an HTTP module');
  assert.equal(await runner.evaluate('fibonacci(10) === 55n'), true);
  await assert.rejects(runner.evaluate("const answer: number = 'wrong'"), /not assignable|TypeScript/);
  assert.equal(await runner.evaluate('const answer: number = 42; answer'), 42);
  await assert.rejects(runner.evaluate("const beforeFailure: number = 7; throw new Error('intentional')"), /intentional/);
  assert.equal(await runner.evaluate('beforeFailure'), 7);
});

test('WebSocket chunks preserve UTF-8 and binary message boundaries above bridge chunk size', { timeout: 90_000 }, async t => {
  const root = await fixture(t);
  const server = await createDemoServer();
  t.after(() => server.dispose());
  await writeFile(join(root, 'main.ts'), `
    const socket = new WebSocket(args[0].replace(/^http/,'ws')+'/socket',['example']);
    socket.binaryType = 'arraybuffer';
    const text = 'X'.repeat(65535) + '🌍' + 'Y'.repeat(65536);
    const binary = new Uint8Array(150000); for(let i=0;i<binary.length;i++) binary[i]=i%251;
    export const result = await new Promise<{text:boolean, length:number, last:number, empty:boolean}>((resolve,reject) => {
      let textOk=false, length=0, last=0, count=0, empty=false;
      socket.onerror=()=>reject(new Error('socket failed'));
      socket.onopen=()=>{socket.send(text);socket.send(binary);socket.send('');};
      socket.onmessage=event=>{
        count++;
        if(count===1) textOk=event.data===text;
        if(count===2) {const value=new Uint8Array(event.data);length=value.length;last=value[value.length-1];}
        if(count===3) {empty=event.data==='';socket.close(1000);}
      };
      socket.onclose=()=>resolve({text:textOk,length,last,empty});
    });
  `);
  const result = await runScript({ root, entry: 'main.ts', allowedOrigins: [server.origin], args: [server.origin], console: quiet });
  assert.deepEqual(result, { text: true, length: 150000, last: 149999 % 251, empty: true });
});

test('a failed compiler cannot replace a working loader/WASM pair', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'bridge'));
  await mkdir(join(root, 'dist/engine'), { recursive: true });
  await mkdir(join(root, 'fake-bin'));
  await cp(new URL('../scripts/build.sh', import.meta.url), join(root, 'scripts/build.sh'));
  await writeFile(join(root, 'bridge/codec.js'), 'void 0;');
  await writeFile(join(root, 'dist/engine/quickjs.js'), 'working loader');
  await writeFile(join(root, 'dist/engine/quickjs.wasm'), 'working wasm');
  const emcc = join(root, 'fake-bin/emcc');
  await writeFile(emcc, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';const out=process.argv[process.argv.indexOf('-o')+1];writeFileSync(out.replace(/\\.js$/,'.wasm'),'incomplete wasm');process.exit(23);\n`);
  await chmod(emcc, 0o755);
  const child = spawnSync('bash', [join(root, 'scripts/build.sh'), '--engine-only'], {
    env: { ...process.env, PATH: `${join(root, 'fake-bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(child.status, 23, child.stderr);
  assert.equal(await readFile(join(root, 'dist/engine/quickjs.js'), 'utf8'), 'working loader');
  assert.equal(await readFile(join(root, 'dist/engine/quickjs.wasm'), 'utf8'), 'working wasm');
});

test('REPL CLI supports multiline input, reset and piped sessions', { timeout: 45_000 }, async t => {
  const root = await fixture(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./runner.mjs', import.meta.url)), '--repl', '--root', root], {
    input: '.editor\nconst n: number =\n  21;\n.end\nn * 2\n.clear\nconst n: string = "reset"; n\n.exit\n',
    encoding: 'utf8', timeout: 40_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.deepEqual(child.stdout.trim().split('\n'), ['42', "'reset'"]);
});
