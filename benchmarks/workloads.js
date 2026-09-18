// Shared, untransformed source for native QuickJS, native Node and JSS.
// Preparation is shared by every backend and runs outside the sample timer.
let preparedBytes, preparedName, preparedSeed;
globalThis.benchPrepare = async function (name, count, seed) {
  preparedBytes = undefined;
  preparedName = name;
  preparedSeed = seed;
  const length = name === 'host-copy-4k' ? 4096
    : ['host-copy-64k', 'host-bytes-64k', 'guest-scan-64k'].includes(name) ? 65536 : 0;
  if (!length) return;
  const bytes = new Uint8Array(length);
  for (let j = 0; j < length; j++) bytes[j] = (seed + j) & 255;
  if (name !== 'guest-scan-64k') {
    const copy = await hostCopy(bytes);
    if (!(copy instanceof Uint8Array) || copy === bytes || copy.buffer === bytes.buffer || copy.length !== length) {
      throw new Error('hostCopy must return an independent byte buffer');
    }
    // Validate the complete payload once per batch, outside measurement. The
    // timed transfer-only loop still consumes changing offsets from each copy.
    for (let j = 0; j < length; j++) {
      if (bytes[j] !== ((seed + j) & 255) || copy[j] !== bytes[j]) throw new Error('hostCopy changed the payload');
    }
    copy[0] ^= 255;
    if (bytes[0] !== (seed & 255)) throw new Error('hostCopy aliases the input');
  }
  preparedBytes = bytes;
};
globalThis.benchIdentity = async function (value) { return value; };
globalThis.benchRun = function (name, count, seed) {
  if (preparedName !== name || preparedSeed !== seed) throw new Error('Call benchPrepare before each batch');
  if (name === 'compute') {
    let checksum = 0;
    for (let i = 0; i < count; i++) {
      let x = (seed + (i & 31)) | 0;
      for (let j = 0; j < 10_000; j++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      }
      checksum = (checksum + (x >>> 0)) >>> 0;
    }
    return checksum;
  }
  if (name === 'json') {
    let checksum = 0;
    for (let i = 0; i < count; i++) {
      const rows = [];
      for (let j = 0; j < 32; j++) rows.push({ id: (seed + (i & 31) + j) >>> 0, name: 'row-' + j, enabled: j % 2 === 0 });
      const copy = JSON.parse(JSON.stringify(rows));
      for (const row of copy) checksum = (checksum + row.id + row.name.length + Number(row.enabled)) >>> 0;
    }
    return checksum;
  }
  if (name === 'guest-scan-64k') {
    const bytes = preparedBytes;
    let checksum = 0;
    for (let i = 0; i < count; i++) {
      bytes[0] = i & 31;
      let sum = 0;
      for (let j = 0; j < bytes.length; j++) sum += bytes[j];
      checksum = (checksum + sum) >>> 0;
    }
    return checksum;
  }
  return (async () => {
    let checksum = 0;
    if (name === 'promise') {
      for (let i = 0; i < count; i++) checksum = (checksum + await Promise.resolve((seed + (i & 31)) >>> 0)) >>> 0;
    } else if (name === 'host-scalar') {
      for (let i = 0; i < count; i++) checksum = (checksum + await hostEcho((seed + (i & 31)) >>> 0)) >>> 0;
    } else if (name === 'host-copy-4k' || name === 'host-copy-64k' || name === 'host-bytes-64k') {
      const bytes = preparedBytes;
      for (let i = 0; i < count; i++) {
        bytes[0] = i & 31;
        const copy = await hostCopy(bytes);
        if (copy === bytes || copy.buffer === bytes.buffer || copy.length !== bytes.length) {
          throw new Error('hostCopy must return an independent byte buffer');
        }
        let sum = 0;
        if (name === 'host-bytes-64k') {
          for (let j = 0; j < copy.length; j++) sum += copy[j];
        } else {
          const mask = copy.length - 1;
          const offset = ((i & 31) * 2053) & mask;
          sum = copy.length + copy[0] + copy[offset] + copy[(offset + 1021) & mask] + copy[mask];
        }
        checksum = (checksum + sum) >>> 0;
      }
    } else throw new Error('Unknown workload: ' + name);
    return checksum;
  })();
};
