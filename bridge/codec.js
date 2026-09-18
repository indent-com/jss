((copyBinary, readBinary, writeBinary) => {
  "use strict";
  const apply = Reflect.apply, ownKeys = Reflect.ownKeys;
  const descriptor = Object.getOwnPropertyDescriptor, proto = Object.getPrototypeOf;
  const rawDefine = Object.defineProperty, setProto = Object.setPrototypeOf, create = Object.create;
  const isArray = Array.isArray, isView = ArrayBuffer.isView, keys = Object.keys;
  const stringify = JSON.stringify, is = Object.is, hasOwn = Object.hasOwn;
  const isInteger = Number.isInteger;
  const arrayProto = Array.prototype, objectProto = Object.prototype;
  const A = Array, AB = ArrayBuffer, U8 = Uint8Array, DV = DataView, BI = BigInt;
  const ErrorCtor = Error, TypeErrorCtor = TypeError;
  const internalCodes = new WeakMap;
  const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
  const binaryBuffers = new WeakSet;
  const weakAdd = WeakSet.prototype.add, weakHas = WeakSet.prototype.has;
  const stringSlice = String.prototype.slice;
  const byteLength = descriptor(AB.prototype, "byteLength").get;
  const viewProto = proto(U8.prototype);
  const viewBuffer = descriptor(viewProto, "buffer").get;
  const viewOffset = descriptor(viewProto, "byteOffset").get;
  const viewLength = descriptor(viewProto, "byteLength").get;
  const viewTag = descriptor(viewProto, Symbol.toStringTag).get;
  const dvBuffer = descriptor(DV.prototype, "buffer").get;
  const dvOffset = descriptor(DV.prototype, "byteOffset").get;
  const dvLength = descriptor(DV.prototype, "byteLength").get;
  const ctors = create(null);
  const constructorPairs = [
    ["Int8Array", Int8Array], ["Uint8Array", U8],
    ["Uint8ClampedArray", Uint8ClampedArray], ["Int16Array", Int16Array],
    ["Uint16Array", Uint16Array], ["Int32Array", Int32Array], ["Uint32Array", Uint32Array],
    ["Float32Array", Float32Array], ["Float64Array", Float64Array],
    ["BigInt64Array", BigInt64Array], ["BigUint64Array", BigUint64Array],
  ];
  for (let i = 0; i < constructorPairs.length; i++) {
    ctors[constructorPairs[i][0]] = constructorPairs[i][1];
  }
  const MAX_BYTES = 16777216, MAX_NODES = 100000, MAX_DEPTH = 100;
  function define(object, name, desc) {
    return rawDefine(object, name, setProto(desc, null));
  }
  function fail(message) {
    const e = new TypeErrorCtor(message);
    define(e, "name", {value:"DataCloneError"});
    define(e, "code", {value:"ERR_CLONE"});
    apply(weakSet, internalCodes, [e, "ERR_CLONE"]);
    throw e;
  }
  function clean(value) {
    if (value !== null && typeof value === "object") {
      if (apply(weakHas, binaryBuffers, [value])) return value;
      setProto(value, null);
      const names = keys(value);
      for (let i = 0; i < names.length; i++) clean(value[names[i]]);
    }
    return value;
  }
  // QuickJS's JSON.stringify uses an ordinary array as its internal cycle
  // stack. An inherited numeric setter can therefore run even after all our
  // output objects were sanitized. Serialize the private data tree ourselves;
  // the captured JSON intrinsic is used only to quote primitive strings.
  function json(value) {
    function render(v) {
      if (v === null) return "null";
      if (typeof v === "string") return stringify(v);
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "number") return v !== v || v === Infinity || v === -Infinity ? "null" : "" + v;
      // Only private snapshots become attachments. Guest records and strings
      // always pass through the ordinary tagged-value/quoting paths.
      if (apply(weakHas, binaryBuffers, [v]))
        return '{"$jssBytes":' + writeBinary(v) + "}";
      if (isArray(v)) {
        let result = "[";
        for (let i = 0; i < v.length; i++) {
          if (i) result += ",";
          result += v[i] === undefined ? "null" : render(v[i]);
        }
        return result + "]";
      }
      let result = "{", separator = "";
      const names = keys(v);
      for (let i = 0; i < names.length; i++) {
        const key = names[i], item = v[key];
        if (item === undefined) continue;
        result += separator + stringify(key) + ":" + render(item);
        separator = ",";
      }
      return result + "}";
    }
    return render(clean(value));
  }
  function budget() {
    return {bytes: 0, nodes: 0, ancestors: []};
  }
  function append(array, value) {
    define(array, array.length, {value, writable:true, enumerable:true, configurable:true});
  }
  function charge(b, bytes, depth) {
    b.bytes += bytes;
    if (b.bytes > MAX_BYTES || depth > MAX_DEPTH)
      fail("Copied value exceeds the conversion limits");
  }
  function encode(value, b, depth) {
    if (++b.nodes > MAX_NODES) fail("Copied value exceeds the node limit");
    charge(b, 16, depth);
    switch (typeof value) {
      case "undefined": return ["undefined"];
      case "boolean": return ["boolean", value];
      case "string": charge(b, value.length * 2, depth); return ["string", value];
      case "number": return ["number",
        value !== value ? "NaN" : value === Infinity ? "Infinity" :
        value === -Infinity ? "-Infinity" : is(value, -0) ? "-0" : value];
      case "bigint": {
        const s = "" + value;
        charge(b, s.length * 2, depth);
        return ["bigint", s];
      }
      case "object": if (value === null) return ["null"]; break;
      default: fail("This value cannot be copied; use a handle");
    }
    for (let i = 0; i < b.ancestors.length; i++)
      if (b.ancestors[i] === value) fail("Cyclic values cannot be copied");
    append(b.ancestors, value);
    try {
      let buffer, offset = 0, length, name;
      try { length = apply(byteLength, value, []); buffer = value; name = "ArrayBuffer"; }
      catch {}
      if (buffer === undefined && isView(value)) {
        try {
          buffer = apply(dvBuffer, value, []);
          offset = apply(dvOffset, value, []);
          length = apply(dvLength, value, []);
          name = "DataView";
        } catch {
          buffer = apply(viewBuffer, value, []);
          offset = apply(viewOffset, value, []);
          length = apply(viewLength, value, []);
          name = apply(viewTag, value, []);
          if (ctors[name] === undefined) fail("Unsupported typed array");
        }
        // Reject SharedArrayBuffer-backed views.
        try { apply(byteLength, buffer, []); } catch { fail("Shared memory cannot be copied"); }
      }
      if (buffer !== undefined) {
        charge(b, length, depth);
        const snapshot = copyBinary(buffer, offset, length);
        apply(weakAdd, binaryBuffers, [snapshot]);
        return ["bytes", name, snapshot];
      }
      const array = isArray(value), prototype = proto(value);
      if (!array && prototype !== objectProto && prototype !== null)
        fail("Only arrays and plain records can be copied");
      let arrayLength = 0;
      if (array) {
        arrayLength = descriptor(value, "length").value;
        if (arrayLength > MAX_NODES) fail("Array length exceeds the conversion limit");
      }
      const names = ownKeys(value), props = [];
      for (let i = 0; i < names.length; i++) {
        const key = names[i];
        const d = descriptor(value, key);
        if (!d || !d.enumerable) continue;
        if (typeof key !== "string") fail("Enumerable symbol properties cannot be copied");
        if (!hasOwn(d, "value")) fail("Accessor properties cannot be copied");
        charge(b, key.length * 2, depth);
        append(props, [key, encode(d.value, b, depth + 1)]);
      }
      return array ? ["array", arrayLength, props] : ["object", props];
    } finally { b.ancestors.length--; }
  }
  function decode(w, b, depth) {
    if (++b.nodes > MAX_NODES) fail("Copied value exceeds the node limit");
    charge(b, 16, depth);
    switch (w[0]) {
      case "undefined": return undefined;
      case "null": return null;
      case "boolean": return w[1];
      case "string": charge(b, w[1].length * 2, depth); return w[1];
      case "number":
        return w[1] === "NaN" ? NaN : w[1] === "Infinity" ? Infinity :
          w[1] === "-Infinity" ? -Infinity : w[1] === "-0" ? -0 : w[1];
      case "bigint": charge(b, w[1].length * 2, depth); return BI(w[1]);
      case "array":
      case "object": {
        const array = w[0] === "array";
        if (array && (!isInteger(w[1]) || w[1] < 0 || w[1] > MAX_NODES))
          fail("Invalid array length");
        const obj = array ? new A(w[1]) : create(objectProto);
        const props = array ? w[2] : w[1];
        for (let i = 0; i < props.length; i++) {
          const key = props[i][0];
          charge(b, key.length * 2, depth);
          define(obj, key, {value: decode(props[i][1], b, depth + 1),
            enumerable:true, writable:true, configurable:true});
        }
        return obj;
      }
      case "bytes": {
        const reference = w[2], name = w[1];
        if (!reference || typeof reference !== "object" || !isInteger(reference.$jssBytes) || reference.$jssBytes < 0)
          fail("Invalid binary attachment");
        const length = readBinary(reference.$jssBytes, true);
        charge(b, length, depth);
        const Ctor = ctors[name];
        if (name !== "ArrayBuffer" && name !== "DataView" && !Ctor)
          fail("Unsupported typed array");
        if (Ctor && length % Ctor.BYTES_PER_ELEMENT !== 0)
          fail("Invalid typed array byte length");
        const buf = readBinary(reference.$jssBytes, false);
        if (w[1] === "ArrayBuffer") return buf;
        if (w[1] === "DataView") return new DV(buf);
        if (name === "Uint8Array") return new U8(buf);
        return new Ctor(buf);
      }
      default: fail("Invalid copied value");
    }
  }
  function boundedProperty(value, key, fallback) {
    try {
      const v = value == null ? undefined : value[key];
      return typeof v === "string" ? apply(stringSlice, v, [0, 8192]) : fallback;
    } catch { return fallback; }
  }
  function error(value) {
    const t = typeof value;
    const fallback = t === "string" ? apply(stringSlice, value, [0, 8192]) :
      t === "number" || t === "boolean" || t === "bigint" ? "" + value :
      value === null ? "null" : t === "undefined" ? "undefined" : "Guest threw a value";
    return {
      name: boundedProperty(value, "name", "Error"),
      message: boundedProperty(value, "message", fallback),
      // Guest-controlled fields never impersonate lifecycle failures.
      code: apply(weakGet, internalCodes, [value]) ?? "ERR_GUEST",
      guestStack: boundedProperty(value, "stack", "")
    };
  }
  return {
    sanitize: clean,
    markError: (value, code) => { apply(weakSet, internalCodes, [value, code]); return value; },
    stringify: json,
    decode: (w) => decode(w, budget(), 0),
    encode: (v) => encode(v, budget(), 0),
    error,
    hostError: (e) => {
      const value = new ErrorCtor(e.message);
      define(value, "name", {value:e.name, configurable:true});
      if (e.code) define(value, "code", {value:e.code, configurable:true});
      return value;
    },
    type: (v) => v === null ? "null" : typeof v,
    keys: (v) => keys(v)
  };
})
