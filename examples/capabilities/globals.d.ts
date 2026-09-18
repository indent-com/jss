/** Globals supplied by examples/runner.mjs. Paths are relative to its --root. */
interface SandboxFileStat {
  readonly type: 'file' | 'directory' | 'other';
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly atimeMs: number;
  readonly birthtimeMs: number;
}
interface SandboxDirectoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
}
interface SandboxFileSystem {
  /** UTF-8 text; maxChars counts Unicode code points, never splits a character. */
  readText(path: string, options?: { maxChars?: number }): Promise<string>;
  readBytes(path: string, options?: { maxBytes?: number }): Promise<Uint8Array<ArrayBuffer>>;
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Alias retained for callers using this spelling. */
  WriteBytes(path: string, bytes: Uint8Array): Promise<void>;
  glob(pattern: string): Promise<string[]>;
  stat(path: string): Promise<SandboxFileStat>;
  readDir(path?: string): Promise<SandboxDirectoryEntry[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
declare const fs: SandboxFileSystem;
declare const args: readonly string[];
interface RequestInit { duplex?: 'half'; }
