import type { ByteSpan } from "../span";

/**
 * bytes の先頭から「実際には何の形式に見えるか」を推定する。
 *
 * PMTiles の Header は Tile Type / Tile Compression を宣言するが、中身がそれに従っている保証は無い
 * （例: Tile Compression = none なのに gzip された MVT が入っている archive は実在する）。
 * 宣言と中身を並べて見せるために、宣言とは独立に bytes だけから判定する。
 *
 * PMTiles の型（offset・entry 等）は一切受け取らない。Tile Content Inspector は bytes だけで動くようにするため。
 * 判定はあくまで推定なので、解凍や decode の根拠には使わない（それは Header の宣言に従う）。
 */
export type SniffKind = "gzip" | "zstd" | "png" | "jpeg" | "webp" | "avif" | "mvt-like" | "text" | "empty" | "unknown";

export interface SniffResult {
  kind: SniffKind;
  /** 判定の根拠になった bytes（bytes 先頭からの位置）。UI で該当 byte を光らせるため */
  evidence?: ByteSpan;
  /** 根拠の説明（例: "1F 8B = gzip の magic"）。表示用だが parser の判断には使わない */
  reason: string;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function sniff(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { kind: "empty", reason: "0 byte" };
  const at = (i: number, sig: readonly number[]) => sig.every((b, k) => bytes[i + k] === b);
  const ascii = (i: number, s: string) => at(i, Array.from(s, (c) => c.charCodeAt(0)));

  // RFC 1952: ID1 ID2 = 1F 8B
  if (at(0, [0x1f, 0x8b])) return { kind: "gzip", evidence: { offset: 0, length: 2 }, reason: "1F 8B = gzip の magic（RFC 1952）" };
  // RFC 8878: magic number 0xFD2FB528 (little-endian)
  if (at(0, [0x28, 0xb5, 0x2f, 0xfd])) return { kind: "zstd", evidence: { offset: 0, length: 4 }, reason: "28 B5 2F FD = zstd frame の magic（RFC 8878）" };
  if (at(0, PNG_SIG)) return { kind: "png", evidence: { offset: 0, length: 8 }, reason: "89 'PNG' 0D 0A 1A 0A = PNG signature" };
  if (at(0, [0xff, 0xd8, 0xff])) return { kind: "jpeg", evidence: { offset: 0, length: 3 }, reason: "FF D8 FF = JPEG の SOI marker" };
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { kind: "webp", evidence: { offset: 0, length: 12 }, reason: "'RIFF' …… 'WEBP' = WebP (RIFF container)" };
  // ISOBMFF: [box size 4B] 'ftyp' [major brand 4B]。AVIF は major brand が avif / avis
  if (ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) {
    return { kind: "avif", evidence: { offset: 4, length: 8 }, reason: "'ftyp' + brand 'avif' = AVIF (ISOBMFF)" };
  }
  // MVT の Tile message は layers (field 3, wire type 2 = length-delimited) の繰り返し。tag = (3 << 3) | 2 = 0x1A
  // 先頭 1 byte だけの弱い判定なので "mvt-like" と呼び、MVT だとは断定しない
  if (bytes[0] === 0x1a) return { kind: "mvt-like", evidence: { offset: 0, length: 1 }, reason: "1A = protobuf の field 3 / length-delimited の tag（MVT の layers）" };
  if (isText(bytes)) return { kind: "text", reason: "全体が制御文字を含まない UTF-8 として読める" };
  return { kind: "unknown", reason: "既知の magic bytes に一致しない" };
}

function isText(bytes: Uint8Array): boolean {
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // タブ・改行以外の制御文字があればバイナリとみなす
    return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
  } catch {
    return false;
  }
}
