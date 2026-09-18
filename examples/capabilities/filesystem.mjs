import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Explicit filesystem capability; this example never exposes Node's fs module. */
export async function createFilesystem(root, { maxBytes = 8 * 1024 * 1024, maxEntries = 10_000 } = {}) {
  root = await fs.realpath(root);
  const inside = path => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
  async function pathFor(path, { missing = false } = {}) {
    if (typeof path !== 'string' || path.includes('\0')) throw new TypeError('Path must be a string without NUL');
    const target = resolve(root, path);
    if (!inside(target)) throw new Error('Path is outside the configured root');
    let current = root;
    for (const part of relative(root, target).split(sep).filter(Boolean)) {
      current = resolve(current, part);
      try {
        const entry = await fs.lstat(current);
        if (entry.isSymbolicLink()) throw new Error('Symbolic links are not exposed by this filesystem capability');
        if (!entry.isFile() && !entry.isDirectory()) throw new Error('Only regular files and directories are exposed');
      } catch (error) {
        if (missing && error.code === 'ENOENT') continue;
        throw error;
      }
    }
    return target;
  }
  function count(value, fallback, name) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes) throw new RangeError(`${name} must be an integer from 0 to ${maxBytes}`);
    return value;
  }
  function options(value) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Options must be an object');
    return value;
  }
  async function openRead(path) {
    const file = await fs.open(await pathFor(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await file.stat()).isFile()) { await file.close(); throw new TypeError('Expected a regular file'); }
    return file;
  }
  async function readBytes(path, opts) {
    const limit = count(options(opts).maxBytes, maxBytes, 'maxBytes');
    await using file = await openRead(path);
    const size = (await file.stat()).size;
    if (options(opts).maxBytes === undefined && size > maxBytes) throw new RangeError('File exceeds the configured byte limit');
    const bytes = new Uint8Array(Math.min(size, limit));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  }
  async function readText(path, opts) {
    const settings = options(opts);
    const limit = count(settings.maxChars, Infinity, 'maxChars');
    await using file = await openRead(path);
    if (settings.maxChars === undefined && (await file.stat()).size > maxBytes) throw new RangeError('File exceeds the configured byte limit');
    const decoder = new TextDecoder();
    const chunk = new Uint8Array(16 * 1024);
    const pieces = [];
    let total = 0, characters = 0;
    while (characters < limit) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null);
      total += bytesRead;
      if (total > maxBytes) throw new RangeError('Read exceeds the configured byte limit');
      const text = decoder.decode(chunk.subarray(0, bytesRead), { stream: bytesRead !== 0 });
      const points = Array.from(text);
      const take = Math.min(points.length, limit - characters);
      pieces.push(points.slice(0, take).join(''));
      characters += take;
      if (!bytesRead) break;
    }
    return pieces.join('');
  }
  async function writeBytes(path, bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('writeBytes expects Uint8Array');
    if (bytes.byteLength > maxBytes) throw new RangeError('Write exceeds the configured byte limit');
    const target = await pathFor(path, { missing: true });
    await using file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    await file.writeFile(bytes);
  }
  async function writeText(path, text) {
    if (typeof text !== 'string') throw new TypeError('writeText expects a string');
    return writeBytes(path, new TextEncoder().encode(text));
  }
  async function stat(path) {
    const value = await fs.stat(await pathFor(path));
    return { type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other', size: value.size,
      mode: value.mode, mtimeMs: value.mtimeMs, atimeMs: value.atimeMs, birthtimeMs: value.birthtimeMs };
  }
  async function glob(pattern) {
    if (typeof pattern !== 'string' || isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) throw new TypeError('Glob must be relative to the configured root');
    const matches = [];
    for await (const path of fs.glob(pattern, { cwd: root })) {
      await pathFor(path);
      if (matches.length >= maxEntries) throw new RangeError('Glob exceeds the configured entry limit');
      matches.push(path.split(sep).join('/'));
    }
    return matches.sort();
  }
  const operations = {
    readText, readBytes, writeText, writeBytes, WriteBytes: writeBytes, glob, stat,
    async mkdir(path, opts) { return void await fs.mkdir(await pathFor(path, { missing: true }), { recursive: Boolean(options(opts).recursive), mode: 0o700 }); },
    async readDir(path = '.') {
      const entries = await fs.readdir(await pathFor(path), { withFileTypes: true });
      if (entries.length > maxEntries) throw new RangeError('Directory exceeds the configured entry limit');
      return entries.map(entry => ({ name: entry.name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
    },
    async remove(path, opts) {
      const target = await pathFor(path);
      if (target === root) throw new Error('Cannot remove the configured root');
      await fs.rm(target, { recursive: Boolean(options(opts).recursive) });
    },
    async rename(from, to) {
      const source = await pathFor(from), target = await pathFor(to, { missing: true });
      if (source === root || target === root) throw new Error('Cannot rename the configured root');
      await fs.rename(source, target);
    },
    async copy(from, to) { await writeBytes(to, await readBytes(from)); },
    async exists(path) { try { await pathFor(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
  };
  return { root, pathFor, handlers: Object.fromEntries(Object.entries(operations).map(([name, fn]) => [`fs.${name}`, fn])) };
}
