import { parentPort } from 'node:worker_threads';
import { serveWorker } from './transport.js';
import { loadWasm } from './node-assets.js';
if (!parentPort) throw new Error('jss worker must run in a worker thread');
const port = parentPort;
serveWorker((message, transfer) => port.postMessage(message, transfer), (receive) => port.on('message', receive), loadWasm);
