export interface MemoryWriter {
  write(chunk: string | Uint8Array): true;
  toString(): string;
}

export function createMemoryWriter(): MemoryWriter {
  let buffer = "";

  return {
    write(chunk: string | Uint8Array) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    toString() {
      return buffer;
    },
  };
}
