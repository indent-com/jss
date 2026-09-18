import { serveWorker } from './transport.js';
import { loadWasm } from './browser-assets.js';
serveWorker((message, transfer) => globalThis.postMessage(message, { transfer }),
  (receive) => globalThis.addEventListener('message', (event: MessageEvent) => receive(event.data)), loadWasm);
