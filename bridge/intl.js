((call) => {
  "use strict";
  // Each operation crosses to the host's Intl as one JSON request; see src/intl.ts.
  const stringify = JSON.stringify, parse = JSON.parse, from = Array.from, isArray = Array.isArray;
  const define = Object.defineProperty, freeze = Object.freeze;
  const dateTime = Date.prototype.getTime, numberValue = Number.prototype.valueOf;
  const bigintValue = BigInt.prototype.valueOf, apply = Reflect.apply;
  const errors = { RangeError, TypeError, Error };
  const state = new WeakMap;
  const get = WeakMap.prototype.get, set = WeakMap.prototype.set;

  const host = (request) => {
    const reply = parse(call(stringify(request)));
    if (!reply.ok) throw new (errors[reply.name] || Error)(reply.message);
    return reply.value;
  };
  const encode = (value) => {
    switch (typeof value) {
      case "undefined": return ["u"];
      case "number": return ["n", value === value && value !== Infinity && value !== -Infinity && !(value === 0 && 1 / value < 0) ? value : (value === 0 ? "-0" : String(value))];
      case "bigint": return ["b", String(value)];
      case "string": return ["s", value];
    }
    if (isArray(value)) return ["a", value.map(encode)];
    return ["j", value === null ? null : parse(stringify(value))];
  };
  const tag = (value) => value instanceof Locale ? apply(localeString, value, []) : value;
  const localesOf = (value) => {
    if (value === undefined || typeof value === "string") return value;
    if (value instanceof Locale) return tag(value);
    if (value === null) throw new TypeError("Cannot convert undefined or null to object");
    return from(value, tag);
  };
  const optionsOf = (value) => value === undefined || value === null ? value : parse(stringify(value));
  const coerce = {
    date: (value) => value === undefined ? undefined : +value,
    num: (value) => typeof value === "bigint" || typeof value === "string" ? value : +value,
    str: (value) => String(value),
    list: (value) => value === undefined ? [] : from(value),
    any: (value) => value,
  };

  const METHODS = {
    Collator: { compare: ["str", "str"] },
    DateTimeFormat: { format: ["date"], formatToParts: ["date"], formatRange: ["date", "date"], formatRangeToParts: ["date", "date"] },
    DisplayNames: { of: ["str"] },
    DurationFormat: { format: ["any"], formatToParts: ["any"] },
    ListFormat: { format: ["list"], formatToParts: ["list"] },
    NumberFormat: { format: ["num"], formatToParts: ["num"], formatRange: ["num", "num"], formatRangeToParts: ["num", "num"] },
    PluralRules: { select: ["num"], selectRange: ["num", "num"] },
    RelativeTimeFormat: { format: ["num", "str"], formatToParts: ["num", "str"] },
    Segmenter: { segment: ["str"] },
  };
  const BOUND = { Collator: "compare", DateTimeFormat: "format", NumberFormat: "format" };
  const CALLABLE = { Collator: true, DateTimeFormat: true, NumberFormat: true };

  const Intl = {};
  define(Intl, Symbol.toStringTag, { value: "Intl", configurable: true });
  const method = (object, name, fn, length) => {
    define(fn, "name", { value: name, configurable: true });
    define(fn, "length", { value: length, configurable: true });
    define(object, name, { value: fn, writable: true, configurable: true });
  };

  for (const ctor of Object.keys(METHODS)) {
    const self = (receiver, name) => {
      const internal = apply(get, state, [receiver]);
      if (internal === undefined || internal.ctor !== ctor) throw new TypeError(`Method Intl.${ctor}.prototype.${name} called on incompatible receiver`);
      return internal;
    };
    const invoke = (internal, name, kinds, args) => host({
      op: "call", ctor, locales: internal.locales, options: internal.options, method: name,
      args: kinds.map((kind, index) => encode(coerce[kind](args[index]))),
    });
    const Ctor = function (locales, options) {
      if (new.target === undefined) {
        if (CALLABLE[ctor]) return new Ctor(locales, options);
        throw new TypeError(`Constructor Intl.${ctor} requires 'new'`);
      }
      const internal = { ctor, locales: localesOf(locales), options: optionsOf(options), bound: undefined };
      host({ op: "new", ctor, locales: internal.locales, options: internal.options });
      apply(set, state, [this, internal]);
    };
    define(Ctor, "name", { value: ctor });
    const proto = Ctor.prototype;
    define(proto, Symbol.toStringTag, { value: `Intl.${ctor}`, configurable: true });
    for (const [name, kinds] of Object.entries(METHODS[ctor])) {
      if (BOUND[ctor] === name) {
        define(proto, name, {
          configurable: true,
          get: function () {
            const internal = self(this, name);
            if (internal.bound === undefined) {
              internal.bound = (...args) => invoke(internal, name, kinds, args);
              define(internal.bound, "length", { value: kinds.length });
            }
            return internal.bound;
          },
        });
      } else if (name === "segment") {
        method(proto, name, function (input) {
          const string = String(input);
          const list = invoke(self(this, name), name, kinds, [string]);
          for (const segment of list) segment.input = string;
          return freeze({
            containing(index) {
              const at = index === undefined ? 0 : Math.trunc(+index) || 0;
              return list.find((segment) => at >= segment.index && at < segment.index + segment.segment.length);
            },
            [Symbol.iterator]: () => list[Symbol.iterator](),
          });
        }, 1);
      } else {
        method(proto, name, function (...args) {
          const value = invoke(self(this, name), name, kinds, args);
          return name === "of" && value === null ? undefined : value;
        }, kinds.length);
      }
    }
    method(proto, "resolvedOptions", function () {
      const internal = self(this, "resolvedOptions");
      return host({ op: "call", ctor, locales: internal.locales, options: internal.options, method: "resolvedOptions", args: [] });
    }, 0);
    method(Ctor, "supportedLocalesOf", function (locales, options) {
      return host({ op: "static", ctor, method: "supportedLocalesOf", args: [encode(localesOf(locales)), encode(optionsOf(options))] });
    }, 1);
    define(Intl, ctor, { value: Ctor, writable: true, configurable: true });
  }

  const locales = new WeakMap;
  const snapshot = (receiver) => {
    const value = apply(get, locales, [receiver]);
    if (value === undefined) throw new TypeError("Method Intl.Locale.prototype called on incompatible receiver");
    return value;
  };
  class Locale {
    constructor(tag, options) {
      if (typeof tag !== "string" && !(tag instanceof Locale) && (tag === null || typeof tag !== "object"))
        throw new TypeError("First argument to Intl.Locale constructor can't be empty or missing");
      apply(set, locales, [this, host({ op: "locale", tag: tag instanceof Locale ? snapshot(tag).tag : String(tag), options: optionsOf(options) })]);
    }
    maximize() { return new Locale(snapshot(this).maximized); }
    minimize() { return new Locale(snapshot(this).minimized); }
    toString() { return snapshot(this).tag; }
  }
  const localeString = Locale.prototype.toString;
  for (const name of ["baseName", "calendar", "caseFirst", "collation", "hourCycle", "language", "numberingSystem", "numeric", "region", "script"])
    define(Locale.prototype, name, { configurable: true, get: function () { const value = snapshot(this)[name]; return value === null ? undefined : value; } });
  define(Locale.prototype, Symbol.toStringTag, { value: "Intl.Locale", configurable: true });
  define(Intl, "Locale", { value: Locale, writable: true, configurable: true });

  method(Intl, "getCanonicalLocales", function (locales) {
    return host({ op: "static", ctor: "", method: "getCanonicalLocales", args: [encode(localesOf(locales))] });
  }, 1);
  method(Intl, "supportedValuesOf", function (key) {
    return host({ op: "static", ctor: "", method: "supportedValuesOf", args: [encode(String(key))] });
  }, 1);
  define(globalThis, "Intl", { value: Intl, writable: true, configurable: true });

  const proto = (type, value, name, args) => host({
    op: "proto", type, method: name, value: encode(value),
    args: args.map(encode),
  });
  for (const name of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"])
    method(Date.prototype, name, function (locales, options) {
      return proto("Date", apply(dateTime, this, []), name, [localesOf(locales), optionsOf(options)]);
    }, 0);
  method(Number.prototype, "toLocaleString", function (locales, options) {
    return proto("Number", apply(numberValue, this, []), "toLocaleString", [localesOf(locales), optionsOf(options)]);
  }, 0);
  method(BigInt.prototype, "toLocaleString", function (locales, options) {
    return proto("BigInt", apply(bigintValue, this, []), "toLocaleString", [localesOf(locales), optionsOf(options)]);
  }, 0);
  const coercible = (value, name) => {
    if (value === undefined || value === null) throw new TypeError(`String.prototype.${name} called on null or undefined`);
    return String(value);
  };
  method(String.prototype, "localeCompare", function (that, locales, options) {
    return proto("String", coercible(this, "localeCompare"), "localeCompare", [String(that), localesOf(locales), optionsOf(options)]);
  }, 1);
  for (const name of ["toLocaleLowerCase", "toLocaleUpperCase"])
    method(String.prototype, name, function (locales) {
      return proto("String", coercible(this, name), name, [localesOf(locales)]);
    }, 0);
  method(Array.prototype, "toLocaleString", function (locales, options) {
    const array = Object(this), length = array.length >>> 0;
    let out = "";
    for (let index = 0; index < length; index++) {
      if (index > 0) out += ",";
      const element = array[index];
      if (element !== undefined && element !== null) out += String(element.toLocaleString(locales, options));
    }
    return out;
  }, 0);
})
