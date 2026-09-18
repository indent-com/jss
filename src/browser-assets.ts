export function normalizeUrl(value: string | URL): string {
  return new URL(String(value), globalThis.location?.href ?? import.meta.url).href;
}
export async function loadWasm(url?: string): Promise<Uint8Array> {
  const asset = url ?? new URL('./engine/quickjs.wasm', import.meta.url);
  const response = await fetch(asset);
  if (!response.ok) throw new Error(`Cannot load QuickJS WASM (${response.status}): ${asset}`);
  return new Uint8Array(await response.arrayBuffer());
}
