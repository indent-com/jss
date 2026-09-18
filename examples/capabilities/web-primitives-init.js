import * as streams from 'web-streams-polyfill';
import encoding from 'text-encoding';

// Evaluate before URL/Blob dependencies, which capture these globals on import.
Object.assign(globalThis, streams, {
  TextEncoder: encoding.TextEncoder,
  TextDecoder: encoding.TextDecoder,
});

// The historical encoding ponyfill predates encodeInto(). Preserve UTF-16 read
// counts and avoid splitting a UTF-8 sequence when filling a caller's buffer.
if (!encoding.TextEncoder.prototype.encodeInto) {
  encoding.TextEncoder.prototype.encodeInto = function (source, destination) {
    source = String(source);
    if (!(destination instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
    let read = 0;
    let written = 0;
    for (const point of source) {
      const bytes = this.encode(point);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += point.length;
    }
    return { read, written };
  };
}

export { streams, encoding };
