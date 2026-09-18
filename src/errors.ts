import type { WireError } from './protocol.js';

/** An error crossing the guest boundary. Guest stacks stay separate from host stacks. */
export class SandboxError extends Error {
  readonly code: string;
  readonly guestStack?: string;
  constructor(message: string, code = 'ERR_GUEST', name = 'SandboxError', guestStack?: string) {
    super(message);
    this.name = name;
    this.code = code;
    this.guestStack = guestStack;
  }
}
export function failure(code: string, message: string, name = 'SandboxError'): SandboxError {
  return new SandboxError(message, code, name);
}
export function fromWire(error: WireError): SandboxError {
  return new SandboxError(error.message, error.code ?? 'ERR_GUEST', error.name, error.guestStack ?? error.stack);
}
export function toWire(value: unknown): WireError {
  try {
    if (value instanceof Error) {
      return {
        name: String(value.name).slice(0, 200), message: String(value.message).slice(0, 8192),
        code: typeof (value as any).code === 'string' ? (value as any).code : undefined,
        guestStack: typeof (value as any).guestStack === 'string' ? (value as any).guestStack.slice(0, 16384) : undefined,
        stack: typeof value.stack === 'string' ? value.stack.slice(0, 16384) : undefined,
      };
    }
    return { name: 'Error', message: String(value).slice(0, 8192) };
  } catch { return { name: 'Error', message: 'Uninspectable thrown value' }; }
}
