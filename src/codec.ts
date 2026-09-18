import type { WireValue } from './protocol.js';
import { failure } from './errors.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 100;
const own = Object.prototype.hasOwnProperty;
const bad = (message: string): never => { throw failure('ERR_CLONE', message, 'DataCloneError'); };
const apply = Reflect.apply;
const U8 = Uint8Array, AB = ArrayBuffer, DV = DataView;
const isView = AB.isView;
const byteLength = Object.getOwnPropertyDescriptor(AB.prototype, 'byteLength')!.get!;
const typedPrototype = Object.getPrototypeOf(U8.prototype);
const viewBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const viewOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const viewLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const viewTag = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)!.get!;
const dataBuffer = Object.getOwnPropertyDescriptor(DV.prototype, 'buffer')!.get!;
const dataOffset = Object.getOwnPropertyDescriptor(DV.prototype, 'byteOffset')!.get!;
const dataLength = Object.getOwnPropertyDescriptor(DV.prototype, 'byteLength')!.get!;
const constructors: Record<string, any> = Object.assign(Object.create(null), {
  Int8Array, Uint8Array: U8, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
});
const setBytes = U8.prototype.set;

function copyBytes(buffer: ArrayBuffer, offset: number, length: number): Uint8Array {
  try {
    const result = new U8(length);
    apply(setBytes, result, [new U8(buffer, offset, length)]);
    return result;
  } catch { return bad('Detached or invalid binary data cannot be copied'); }
}

function binary(value: object): { buffer: ArrayBuffer; offset: number; length: number; name: string } | undefined {
  if (!isView(value)) {
    if (!(value instanceof AB)) return undefined;
    try { return { buffer: value, offset: 0, length: apply(byteLength, value, []), name: 'ArrayBuffer' }; }
    catch { return undefined; }
  }
  let result;
  try {
    result = { buffer: apply(dataBuffer, value, []), offset: apply(dataOffset, value, []), length: apply(dataLength, value, []), name: 'DataView' };
  } catch {
    result = { buffer: apply(viewBuffer, value, []), offset: apply(viewOffset, value, []), length: apply(viewLength, value, []), name: apply(viewTag, value, []) };
    if (!constructors[result.name]) bad('Unsupported binary type');
  }
  try { apply(byteLength, result.buffer, []); } catch { bad('Shared memory cannot cross the guest boundary'); }
  return result;
}

/** The copied-value subset deliberately has the same semantics in either execution mode. */
export function encode(value: unknown): WireValue {
  const ancestors = new Set<object>();
  let nodes = 0, bytes = 0;
  function visit(value: any, depth: number): WireValue {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) bad('Value exceeds the copy depth or node limit');
    const size = typeof value === 'string' ? value.length * 2 : 16;
    if ((bytes += size) > MAX_BYTES) bad('Value exceeds the 16 MiB copy limit');
    if (value === undefined) return ['undefined'];
    if (value === null) return ['null'];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value === 'string') return ['string', value];
    if (typeof value === 'number') return ['number', Number.isNaN(value) ? 'NaN' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : Object.is(value, -0) ? '-0' : value];
    if (typeof value === 'bigint') {
      const digits = value.toString();
      if ((bytes += digits.length * 2) > MAX_BYTES) bad('BigInt exceeds the copy limit');
      return ['bigint', digits];
    }
    if (typeof value !== 'object') bad(`Cannot copy ${typeof value}; use a guest handle`);
    if (ancestors.has(value)) bad('Cannot copy a cyclic value; use a guest handle');
    const data = binary(value);
    if (data) {
      if ((bytes += data.length) > MAX_BYTES) bad('Binary value exceeds the copy limit');
      return ['bytes', data.name, copyBytes(data.buffer, data.offset, data.length)];
    }
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (!array && proto !== null && proto !== Object.prototype) bad('Only plain records can be copied; use a guest handle');
    if (array && value.length > MAX_NODES) bad('Array length exceeds the copy limit');
    ancestors.add(value);
    try {
      const entries: [string, WireValue][] = [];
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable) continue;
        if (typeof key !== 'string') bad('Symbol properties cannot be copied; use a guest handle');
        if (!own.call(descriptor, 'value')) bad('Accessor properties cannot be copied; use a guest handle');
        if ((bytes += (key as string).length * 2) > MAX_BYTES) bad('Property names exceed the copy limit');
        entries.push([key as string, visit(descriptor.value, depth + 1)]);
      }
      return array ? ['array', value.length, entries] : ['object', entries];
    } finally { ancestors.delete(value); }
  }
  return visit(value, 0);
}

export function decode(wire: WireValue): unknown {
  let nodes = 0, bytes = 0;
  function visit(value: WireValue, depth: number): any {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH || !Array.isArray(value)) bad('Invalid or oversized guest value');
    if ((bytes += 16) > MAX_BYTES) bad('Guest value exceeds the copy limit');
    switch (value[0]) {
      case 'undefined': return undefined;
      case 'null': return null;
      case 'boolean': return value[1];
      case 'number': return typeof value[1] === 'number' ? value[1] : value[1] === 'NaN' ? NaN : value[1] === 'Infinity' ? Infinity : value[1] === '-Infinity' ? -Infinity : -0;
      case 'string':
        if ((bytes += value[1].length * 2) > MAX_BYTES) bad('Guest string exceeds the copy limit');
        return value[1];
      case 'bigint':
        if ((bytes += value[1].length * 2) > MAX_BYTES) bad('Guest BigInt exceeds the copy limit');
        return BigInt(value[1]);
      case 'array': case 'object': {
        const array = value[0] === 'array';
        if (array && (!Number.isSafeInteger(value[1]) || (value[1] as number) < 0 || (value[1] as number) > MAX_NODES)) bad('Invalid guest array length');
        const result: any = array ? new Array(value[1] as number) : {};
        const entries = (array ? value[2] : value[1]) as [string, WireValue][];
        for (const [key, child] of entries) {
          if ((bytes += key.length * 2) > MAX_BYTES) bad('Guest property names exceed the copy limit');
          Object.defineProperty(result, key, { value: visit(child, depth + 1), enumerable: true, configurable: true, writable: true });
        }
        return result;
      }
      case 'bytes': {
        const name = value[1], Ctor = constructors[name];
        const source = binary(value[2]);
        if (!source || source.name !== 'Uint8Array') bad('Invalid binary attachment');
        const { buffer: backing, offset, length } = source!;
        if ((!Ctor && name !== 'ArrayBuffer' && name !== 'DataView') || (bytes += length) > MAX_BYTES) bad('Unsupported or oversized guest binary data');
        if (Ctor && length % Ctor.BYTES_PER_ELEMENT !== 0) bad('Invalid typed array byte length');
        const data = copyBytes(backing, offset, length), buffer = apply(viewBuffer, data, []);
        if (name === 'ArrayBuffer') return buffer;
        if (name === 'DataView') return new DV(buffer);
        return name === 'Uint8Array' ? data : new Ctor(buffer);
      }
      default: return bad('Unknown guest value encoding');
    }
  }
  return visit(wire, 0);
}
