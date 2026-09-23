import type { Spanned } from "./span";

/**
 * Protocol Buffers 形式の unsigned varint (little-endian base-128) を 1 つ読む。
 *
 * 公式実装はビット演算を 32bit ずつに分けて高速化しているが、
 * ここでは「7bit ずつ下位から積み上げる」という仕様そのままの形で書く。
 * JS の number は 2^53 までしか正確に表せないため、それを超える値は黙って丸めずに例外にする。
 */
export function readVarint(buf: Uint8Array, pos: number): Spanned<number> {
  let value = 0;
  let multiplier = 1;
  for (let i = 0; i < 10; i++) {
    const b = buf[pos + i];
    if (b === undefined) {
      throw new RangeError(`varint がバッファ終端で途切れています (pos=${pos})`);
    }
    value += (b & 0x7f) * multiplier;
    if (b < 0x80) {
      if (!Number.isSafeInteger(value)) {
        throw new RangeError(`varint が Number.MAX_SAFE_INTEGER を超えています (pos=${pos})`);
      }
      return { value, offset: pos, length: i + 1 };
    }
    multiplier *= 128;
  }
  throw new RangeError(`varint が 10 byte を超えています (pos=${pos})`);
}

/** 教材表示・テスト用のエンコーダ。Directory Encoding Viewer で「値 → bytes」を示すのに使う。 */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`varint にできない値です: ${value}`);
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Uint8Array.from(out);
}
