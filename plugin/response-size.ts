// Leave ample room below the bridge's 16 MiB frame limit (including recovered results).
import limits from '../src/response-limits.json';
export const MAX_RESULT_BYTES = limits.maxResultBytes;
export const DEFAULT_READ_BYTES = limits.defaultReadBytes;

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

export function utf8Bytes(text: string): number {
  let bytes = 0;
  // Plugin sandbox has no TextEncoder. JSON escapes unpaired surrogates.
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
