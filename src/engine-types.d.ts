declare module '*engine/quickjs.js' {
  const factory: (options: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
