/** Host half of the `intl` option: the guest's Intl shim sends one JSON request per
 * call and gets one JSON reply back, synchronously, from the engine's own thread.
 * Requests name a fixed constructor and method; nothing else on the host is reachable. */

const DEFAULT_LOCALE = 'en-US';
const DEFAULT_TIME_ZONE = 'UTC';
const CACHE_ENTRIES = 64;

const METHODS: Record<string, readonly string[]> = {
  Collator: ['compare', 'resolvedOptions'],
  DateTimeFormat: ['format', 'formatToParts', 'formatRange', 'formatRangeToParts', 'resolvedOptions'],
  DisplayNames: ['of', 'resolvedOptions'],
  DurationFormat: ['format', 'formatToParts', 'resolvedOptions'],
  ListFormat: ['format', 'formatToParts', 'resolvedOptions'],
  NumberFormat: ['format', 'formatToParts', 'formatRange', 'formatRangeToParts', 'resolvedOptions'],
  PluralRules: ['select', 'selectRange', 'resolvedOptions'],
  RelativeTimeFormat: ['format', 'formatToParts', 'resolvedOptions'],
  Segmenter: ['segment', 'resolvedOptions'],
};
const PROTOTYPES: Record<string, readonly string[]> = {
  BigInt: ['toLocaleString'],
  Date: ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'],
  Number: ['toLocaleString'],
  String: ['localeCompare', 'toLocaleLowerCase', 'toLocaleUpperCase'],
};

type Encoded = ['u'] | ['n', number | string] | ['b', string] | ['s', string] | ['a', Encoded[]] | ['j', unknown];
type Request =
  | { op: 'new'; ctor: string; locales: unknown; options: unknown }
  | { op: 'call'; ctor: string; locales: unknown; options: unknown; method: string; args: Encoded[] }
  | { op: 'static'; ctor: string; method: string; args: Encoded[] }
  | { op: 'proto'; type: string; method: string; value: Encoded; args: Encoded[] }
  | { op: 'locale'; tag: unknown; options: unknown };

function decode(value: Encoded): unknown {
  switch (value[0]) {
    case 'u': return undefined;
    case 'n': return typeof value[1] === 'number' ? value[1] : Number(value[1]);
    case 'b': return BigInt(value[1]);
    case 's': return value[1];
    case 'a': return value[1].map(decode);
    case 'j': return value[1];
  }
  throw new TypeError('Invalid Intl argument');
}

function locales(value: unknown): unknown {
  return value === undefined || (Array.isArray(value) && value.length === 0) ? DEFAULT_LOCALE : value;
}

/** Date formatting reads the host's zone only when none is named, so name one. */
function zoned(options: unknown): unknown {
  if (options === undefined) return { timeZone: DEFAULT_TIME_ZONE };
  if (options === null || typeof options !== 'object' || 'timeZone' in options) return options;
  return { ...options, timeZone: DEFAULT_TIME_ZONE };
}

function constructor(name: string): new (locales: unknown, options: unknown) => any {
  const intl = Intl as unknown as Record<string, unknown>;
  const ctor = intl[name];
  if (!Object.hasOwn(METHODS, name) || typeof ctor !== 'function') throw new TypeError(`Intl.${name} is not available`);
  return ctor as new (locales: unknown, options: unknown) => any;
}

function segments(result: Iterable<{ segment: string; index: number; isWordLike?: boolean }>): unknown[] {
  return Array.from(result, ({ segment, index, isWordLike }) => isWordLike === undefined ? { segment, index } : { segment, index, isWordLike });
}

export function createIntlHost(): (request: string) => string {
  const cache = new Map<string, any>();
  const formatter = (ctor: string, requested: unknown, options: unknown): any => {
    const key = JSON.stringify([ctor, requested, options]);
    let instance = cache.get(key);
    if (instance === undefined) {
      instance = new (constructor(ctor))(locales(requested), ctor === 'DateTimeFormat' ? zoned(options) : options);
      if (cache.size === CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    } else cache.delete(key);
    cache.set(key, instance);
    return instance;
  };
  const run = (request: Request): unknown => {
    switch (request.op) {
      case 'new':
        formatter(request.ctor, request.locales, request.options);
        return null;
      case 'call': {
        if (!METHODS[request.ctor]?.includes(request.method)) throw new TypeError(`Intl.${request.ctor}.prototype.${request.method} is not available`);
        const instance = formatter(request.ctor, request.locales, request.options);
        const result: unknown = instance[request.method](...request.args.map(decode));
        return request.method === 'segment' ? segments(result as Iterable<{ segment: string; index: number }>) : result;
      }
      case 'static':
        if (request.ctor === '') {
          if (request.method === 'getCanonicalLocales') return Intl.getCanonicalLocales(...(request.args.map(decode) as [string[]]));
          if (request.method === 'supportedValuesOf') return Intl.supportedValuesOf(...(request.args.map(decode) as [any]));
        } else if (request.method === 'supportedLocalesOf') {
          return (constructor(request.ctor) as any).supportedLocalesOf(...request.args.map(decode));
        }
        throw new TypeError(`Intl.${request.method} is not available`);
      case 'proto': {
        if (!PROTOTYPES[request.type]?.includes(request.method)) throw new TypeError(`${request.type}.prototype.${request.method} is not available`);
        const value = decode(request.value);
        const args = request.args.map(decode);
        if (request.type === 'Date') return (Date.prototype as any)[request.method].call(new Date(value as number), locales(args[0]), zoned(args[1]));
        if (request.type === 'String' && request.method === 'localeCompare') return String(value).localeCompare(args[0] as string, locales(args[1]) as string, args[2] as Intl.CollatorOptions);
        const prototype = { BigInt: BigInt.prototype, Number: Number.prototype, String: String.prototype }[request.type as 'BigInt' | 'Number' | 'String'];
        return (prototype as any)[request.method].call(value, locales(args[0]), args[1]);
      }
      case 'locale': {
        const locale = new Intl.Locale(request.tag as string, request.options as Intl.LocaleOptions);
        return {
          baseName: locale.baseName, calendar: locale.calendar, caseFirst: locale.caseFirst,
          collation: locale.collation, hourCycle: locale.hourCycle, language: locale.language,
          maximized: locale.maximize().toString(), minimized: locale.minimize().toString(),
          numberingSystem: locale.numberingSystem, numeric: locale.numeric, region: locale.region,
          script: locale.script, tag: locale.toString(),
        };
      }
    }
    throw new TypeError('Invalid Intl request');
  };
  return (text) => {
    try {
      const value = run(JSON.parse(text) as Request);
      return JSON.stringify({ ok: true, value: value === undefined ? null : value });
    } catch (error) {
      const name = error instanceof RangeError ? 'RangeError' : error instanceof TypeError ? 'TypeError' : 'Error';
      return JSON.stringify({ ok: false, name, message: error instanceof Error ? error.message : String(error) });
    }
  };
}
