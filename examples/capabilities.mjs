import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import { runScript } from './runner.mjs';

/** A deterministic local service: examples never depend on a public echo server. */
export async function createDemoServer({ port = 0 } = {}) {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const path = new URL(incoming.url, 'http://localhost').pathname;
      if (path === '/remote.ts') {
        outgoing.writeHead(200, { 'content-type': 'application/typescript' });
        outgoing.end('export function greeting(name: string): string { return `Hello, ${name}, from an HTTP module`; }');
      } else if (path === '/echo') {
        outgoing.writeHead(200, { 'content-type': incoming.headers['content-type'] ?? 'application/octet-stream' });
        incoming.pipe(outgoing);
      } else if (path === '/stream') {
        outgoing.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        outgoing.write('streaming ');
        setTimeout(() => outgoing.end('response 🌍'), 10);
      } else if (path === '/form') {
        const request = new Request('http://localhost/form', { method: 'POST', body: Readable.toWeb(incoming), duplex: 'half', headers: incoming.headers });
        const form = await request.formData();
        const file = form.get('file');
        outgoing.writeHead(200, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ message: form.get('message'), fileName: file?.name, fileText: await file?.text() }));
      } else if (path === '/redirect') {
        outgoing.writeHead(302, { location: '/stream' }); outgoing.end();
      } else if (path === '/redirect-out') {
        outgoing.writeHead(302, { location: 'http://127.0.0.1:1/not-authorized' }); outgoing.end();
      } else if (path === '/slow') {
        const timer = setTimeout(() => outgoing.end('late'), 5_000);
        outgoing.on('close', () => clearTimeout(timer));
      } else { outgoing.writeHead(404); outgoing.end('Not found'); }
    })().catch(error => { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(String(error)); });
  });
  const sockets = new WebSocketServer({ server, path: '/socket', handleProtocols: protocols => protocols.has('example') ? 'example' : false });
  sockets.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })));
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async dispose() {
      for (const client of sockets.clients) client.terminate();
      await new Promise(resolve => sockets.close(resolve));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export async function runDemo() {
  const root = await mkdtemp(join(tmpdir(), 'jss-capabilities-'));
  const server = await createDemoServer();
  try {
    await cp(new URL('./capabilities/fixtures/', import.meta.url), root, { recursive: true });
    return await runScript({ root, entry: 'main.ts', allowedOrigins: [server.origin], args: [server.origin] });
  } finally { await server.dispose(); await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === '--serve') {
    const server = await createDemoServer({ port: 8787 });
    console.log(`Example HTTP modules, Fetch endpoints and WebSocket echo: ${server.origin}`);
    const close = () => { void server.dispose().then(() => { process.exitCode = 0; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } else runDemo().then(result => console.log(JSON.stringify(result, null, 2)), error => { console.error(error); process.exitCode = 1; });
}
