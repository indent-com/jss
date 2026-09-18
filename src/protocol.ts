/** Private, versioned transport. It carries no pointers or executable host values. */
export type WireValue =
  | ["undefined"] | ["null"]
  | ["boolean", boolean]
  | ["number", number | "NaN" | "Infinity" | "-Infinity" | "-0"]
  | ["string", string] | ["bigint", string]
  | ["array", number, [string, WireValue][]]
  | ["object", [string, WireValue][]]
  | ["bytes", string, Uint8Array];
export type Input = { handle: number } | { value: WireValue };
export interface WireError { name: string; message: string; code?: string; stack?: string; guestStack?: string; }
export interface Command { op: string; args: any[]; }
export interface EngineOptions {
  memoryLimitBytes: number;
  stackLimitBytes: number;
  timeoutMs: number;
  wasmBinary?: Uint8Array;
  wasmUrl?: string;
}
export interface EngineHooks {
  hostCall(callId: number, functionId: number, thisId: number, args: number[], copied?: WireValue[]): void;
  onUnhandled(error: WireError): void;
  onFatal(error: WireError): void;
}
export type ToWorker =
  | { kind: "init"; options: EngineOptions }
  | { kind: "execute"; id: number; command: Command; timeoutMs: number }
  | { kind: "settle"; callId: number; value: Input; error?: WireError }
  | { kind: "dispose" };
export type FromWorker =
  | { kind: "ready" }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: WireError }
  | { kind: "hostCall"; callId: number; functionId: number; thisId: number; args: number[]; copied?: WireValue[] }
  | { kind: "unhandled"; error: WireError }
  | { kind: "fatal"; error: WireError }
  | { kind: "disposed" };
