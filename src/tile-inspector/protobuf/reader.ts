import type { ByteSpan } from "../span";

/**
 * Protocol Buffers の wire format を「field の並び」として読む最小の reader。
 *
 * 公式 pbf のようにスキーマ付きで値だけを取り出すのではなく、各 field の tag・length prefix・中身の byte 範囲を残す。
 * MVT Inspector が「この値は Payload のどの byte から来たか」を示すための土台であり、
 * Phase 8 の byte 単位ハイライトもこの span をそのまま使う。
 *
 * https://protobuf.dev/programming-guides/encoding/
 */
export const WireType = {
  Varint: 0,
  I64: 1,
  Len: 2,
  /** group は proto2 の古い形式。MVT では使われないので読まずにエラーにする */
  SGroup: 3,
  EGroup: 4,
  I32: 5,
} as const;

export const WIRE_TYPE_NAMES: Record<number, string> = { 0: "VARINT", 1: "I64", 2: "LEN", 3: "SGROUP", 4: "EGROUP", 5: "I32" };

export interface PbField {
  field: number;
  wireType: number;
  /** tag の先頭から値の終わりまで */
  span: ByteSpan;
  /** tag（= field 番号 << 3 | wire type）の varint */
  tag: ByteSpan;
  /** LEN の length prefix の varint。LEN 以外には無い */
  lengthPrefix?: ByteSpan;
  /** 値の bytes。LEN は length prefix を除いた中身 */
  value: ByteSpan;
}

/** 壊れた protobuf。offset は読めなくなった位置（bytes 先頭からの相対位置） */
export class PbError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message}（+${offset}）`);
  }
}

/** varint は 64bit 値を 7bit ずつ詰めるので最大 10 byte */
const MAX_VARINT_BYTES = 10;

/**
 * varint を number として読む。2^53 を超える値は丸めずに例外にする（黙って精度を落とさない）。
 * 64bit を扱う field（id / int64 など）は readVarintBig を使う。
 */
export function readVarint(buf: Uint8Array, pos: number, end: number): { value: number; next: number } {
  let value = 0;
  // ビットシフトは 32bit に切り詰められるので、掛け算で桁を上げる
  let mul = 1;
  let p = pos;
  for (;;) {
    if (p >= end) throw new PbError("varint が途中で切れている", pos);
    const b = buf[p++]!;
    value += (b & 0x7f) * mul;
    if (b < 0x80) break;
    mul *= 128;
    if (p - pos >= MAX_VARINT_BYTES) throw new PbError("varint が 10 byte を超える", pos);
  }
  if (value > Number.MAX_SAFE_INTEGER) throw new PbError("varint が 2^53 を超える（number では表せない）", pos);
  return { value, next: p };
}

/** varint を 64bit の符号なし整数（bigint）として読む */
export function readVarintBig(buf: Uint8Array, pos: number, end: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let p = pos;
  for (;;) {
    if (p >= end) throw new PbError("varint が途中で切れている", pos);
    const b = buf[p++]!;
    value |= BigInt(b & 0x7f) << shift;
    if (b < 0x80) break;
    shift += 7n;
    if (p - pos >= MAX_VARINT_BYTES) throw new PbError("varint が 10 byte を超える", pos);
  }
  // 10 byte 目の余分な bit は 64bit の外なので捨てる（protobuf の実装と同じ）
  return { value: BigInt.asUintN(64, value), next: p };
}

/** 値を作らずに varint の終わりだけを求める（field を並べるだけの段階で 64bit 値を組み立てるのは無駄なため） */
function skipVarint(buf: Uint8Array, pos: number, end: number): number {
  for (let p = pos; p < end && p - pos < MAX_VARINT_BYTES; p++) if (buf[p]! < 0x80) return p + 1;
  throw new PbError(end - pos >= MAX_VARINT_BYTES ? "varint が 10 byte を超える" : "varint が途中で切れている", pos);
}

/** [start, end) を field の並びとして読む。未知の field も飛ばさずに返す（Inspector は「何が入っているか」を全部見せたい） */
export function readFields(buf: Uint8Array, start = 0, end = buf.length): PbField[] {
  const r = readFieldsLenient(buf, start, end);
  if (r.error) throw r.error;
  return r.fields;
}

/** 壊れた位置で止まり、そこまでに読めた field と止まった理由を返す（壊れた tile でも読めたところまでは見せるため） */
export function readFieldsLenient(buf: Uint8Array, start = 0, end = buf.length): { fields: PbField[]; error?: PbError } {
  const out: PbField[] = [];
  try {
    readInto(buf, start, end, out);
  } catch (e) {
    if (e instanceof PbError) return { fields: out, error: e };
    throw e;
  }
  return { fields: out };
}

function readInto(buf: Uint8Array, start: number, end: number, out: PbField[]) {
  let p = start;
  while (p < end) {
    const t = readVarint(buf, p, end);
    const field = Math.floor(t.value / 8);
    const wireType = t.value % 8;
    if (field === 0) throw new PbError("field 番号 0 は不正", p);
    const tag = { offset: p, length: t.next - p };
    let valueStart = t.next;
    let valueEnd: number;
    let lengthPrefix: ByteSpan | undefined;
    switch (wireType) {
      case WireType.Varint:
        valueEnd = skipVarint(buf, valueStart, end);
        break;
      case WireType.I64:
        valueEnd = valueStart + 8;
        break;
      case WireType.I32:
        valueEnd = valueStart + 4;
        break;
      case WireType.Len: {
        const len = readVarint(buf, valueStart, end);
        lengthPrefix = { offset: valueStart, length: len.next - valueStart };
        valueStart = len.next;
        valueEnd = valueStart + len.value;
        break;
      }
      default:
        throw new PbError(`wire type ${wireType}（${WIRE_TYPE_NAMES[wireType] ?? "未定義"}）には対応していない`, p);
    }
    if (valueEnd > end) throw new PbError(`field ${field} の値が message の終わりを越える`, valueStart);
    out.push({ field, wireType, span: { offset: p, length: valueEnd - p }, tag, lengthPrefix, value: { offset: valueStart, length: valueEnd - valueStart } });
    p = valueEnd;
  }
}

export function fieldVarint(buf: Uint8Array, f: PbField): number {
  return readVarint(buf, f.value.offset, f.value.offset + f.value.length).value;
}

export function fieldVarintBig(buf: Uint8Array, f: PbField): bigint {
  return readVarintBig(buf, f.value.offset, f.value.offset + f.value.length).value;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function fieldString(buf: Uint8Array, f: PbField): string {
  try {
    return utf8.decode(buf.subarray(f.value.offset, f.value.offset + f.value.length));
  } catch {
    throw new PbError("string が UTF-8 として読めない", f.value.offset);
  }
}

/** float / double は little-endian の IEEE 754 */
export function fieldFloat(buf: Uint8Array, f: PbField): number {
  return new DataView(buf.buffer, buf.byteOffset + f.value.offset, 4).getFloat32(0, true);
}

export function fieldDouble(buf: Uint8Array, f: PbField): number {
  return new DataView(buf.buffer, buf.byteOffset + f.value.offset, 8).getFloat64(0, true);
}

/** sint の zigzag: 0, -1, 1, -2 … を 0, 1, 2, 3 … に割り当てて、小さい負数も短い varint にする */
export function zigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

export function zigzagBig(n: bigint): bigint {
  return (n >> 1n) ^ -(n & 1n);
}

/**
 * repeated uint32 を読む。spec 上は packed（LEN の中に varint が並ぶ）だが、
 * protobuf の parser は packed でない形（VARINT が 1 つずつ）も受け付けなければならないので両方読む。
 */
export function appendUint32s(buf: Uint8Array, f: PbField, out: number[]): void {
  const end = f.value.offset + f.value.length;
  if (f.wireType === WireType.Varint) {
    out.push(readVarint(buf, f.value.offset, end).value);
    return;
  }
  if (f.wireType !== WireType.Len) throw new PbError(`repeated uint32 に wire type ${f.wireType} は使えない`, f.tag.offset);
  let p = f.value.offset;
  while (p < end) {
    const v = readVarint(buf, p, end);
    out.push(v.value);
    p = v.next;
  }
}
