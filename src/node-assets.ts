import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function normalizeUrl(value: string | URL): string {
  if (value instanceof URL) return value.href;
  try { return new URL(value).href; } catch { return pathToFileURL(resolve(value)).href; }
}
export async function loadWasm(url?: string): Promise<Uint8Array> {
  const asset = url ? new URL(url) : new URL('./engine/quickjs.wasm', import.meta.url);
  if (asset.protocol === 'file:') return new Uint8Array(await readFile(asset));
  const response = await fetch(asset);
  if (!response.ok) throw new Error(`Cannot load QuickJS WASM (${response.status}): ${asset}`);
  return new Uint8Array(await response.arrayBuffer());
}
