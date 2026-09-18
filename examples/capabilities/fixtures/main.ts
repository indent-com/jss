import { fibonacci } from './math.ts';

const origin = args[0];
if (!origin) throw new Error('Pass the demo server origin as the first script argument');

await fs.mkdir('output', { recursive: true });
await fs.writeText('output/greeting.txt', 'Hello, 世界 🌍');
const greeting = await fs.readText('output/greeting.txt', { maxChars: 9 });
await fs.writeBytes('output/binary.dat', new Uint8Array([0, 127, 255]));
const bytes = await fs.readBytes('output/binary.dat');
const files = await fs.glob('output/*');
const stat = await fs.stat('output/greeting.txt');

// Both imports are resolved and checked as TypeScript before their code runs.
const local = await import('./math.ts');
const remote = await import(`${origin}/remote.ts`);

const request = new Request(`${origin}/echo`, {
  method: 'POST',
  headers: new Headers({ 'content-type': 'text/plain', 'x-example': 'quickjs' }),
  body: 'A request from QuickJS',
  signal: AbortSignal.timeout(5_000),
});
const response = await fetch(request);
const copy = response.clone();
const echoed = await response.text();
const blob = await copy.blob();

// Response bodies are streams, not prebuffered text.
const streamed = await fetch(`${origin}/stream`);
let streamedText = '';
const decoder = new TextDecoder();
for await (const chunk of streamed.body!) streamedText += decoder.decode(chunk, { stream: true });
streamedText += decoder.decode();

const form = new FormData();
form.set('message', 'Hello');
form.set('file', new File(['🌍'], 'world.txt', { type: 'text/plain' }));
const upload = await fetch(`${origin}/form`, { method: 'POST', body: form });
const uploaded: unknown = await upload.json();

const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/socket', ['example']);
socket.binaryType = 'arraybuffer';
const messages = await new Promise<Array<string | number[]>>((resolve, reject) => {
  const received: Array<string | number[]> = [];
  socket.onopen = () => {
    socket.send('Hello over WebSocket');
    socket.send(new Blob([new Uint8Array([1, 2, 3])]));
  };
  socket.onmessage = event => {
    received.push(typeof event.data === 'string' ? event.data : Array.from(new Uint8Array(event.data)));
    if (received.length === 2) socket.close(1000, 'done');
  };
  socket.onerror = () => reject(new Error('WebSocket failed'));
  socket.onclose = event => {
    if (event.wasClean && event.code === 1000) resolve(received);
    else reject(new Error(`Unexpected WebSocket close: ${event.code}`));
  };
});

export const result = {
  fibonacci: fibonacci(100).toString(),
  dynamicFibonacci: local.fibonacci(10).toString(),
  remote: remote.greeting('QuickJS'),
  greeting, bytes: Array.from(bytes), files, fileSize: stat.size,
  echoed, blobSize: blob.size, contentType: response.headers.get('content-type'),
  streamedText, uploaded, messages,
};
console.log('Guest finished with WebSocket protocol:', socket.protocol);
