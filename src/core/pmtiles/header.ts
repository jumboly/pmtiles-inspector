import type { ByteSpan } from "./span";

export const HEADER_SIZE = 127;
/** spec §2: header + 圧縮後 root directory はこの範囲に収まらなければならない */
export const FIRST_READ_SIZE = 16384;
const MAGIC = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]; // "PMTiles"

/**
 * Header の物理レイアウト (spec §3.1)。
 *
 * parser の実装と Hex Viewer のハイライトが同じ表を参照するよう、レイアウトをデータとして持つ。
 * こうしておけば「表示上の byte 位置」と「実際に読んだ byte 位置」がずれることがない。
 */
export const HEADER_LAYOUT = [
  { key: "magic", offset: 0, length: 7, kind: "magic" },
  { key: "specVersion", offset: 7, length: 1, kind: "u8" },
  { key: "rootDirectoryOffset", offset: 8, length: 8, kind: "u64" },
  { key: "rootDirectoryLength", offset: 16, length: 8, kind: "u64" },
  { key: "metadataOffset", offset: 24, length: 8, kind: "u64" },
  { key: "metadataLength", offset: 32, length: 8, kind: "u64" },
  { key: "leafDirectoriesOffset", offset: 40, length: 8, kind: "u64" },
  { key: "leafDirectoriesLength", offset: 48, length: 8, kind: "u64" },
  { key: "tileDataOffset", offset: 56, length: 8, kind: "u64" },
  { key: "tileDataLength", offset: 64, length: 8, kind: "u64" },
  { key: "numAddressedTiles", offset: 72, length: 8, kind: "u64" },
  { key: "numTileEntries", offset: 80, length: 8, kind: "u64" },
  { key: "numTileContents", offset: 88, length: 8, kind: "u64" },
  { key: "clustered", offset: 96, length: 1, kind: "u8" },
  { key: "internalCompression", offset: 97, length: 1, kind: "u8" },
  { key: "tileCompression", offset: 98, length: 1, kind: "u8" },
  { key: "tileType", offset: 99, length: 1, kind: "u8" },
  { key: "minZoom", offset: 100, length: 1, kind: "u8" },
  { key: "maxZoom", offset: 101, length: 1, kind: "u8" },
  // Position は 8 byte (lon 4 + lat 4) だが、UI で lon / lat を別々に指せるよう 4 byte ずつに分ける
  { key: "minLon", offset: 102, length: 4, kind: "e7" },
  { key: "minLat", offset: 106, length: 4, kind: "e7" },
  { key: "maxLon", offset: 110, length: 4, kind: "e7" },
  { key: "maxLat", offset: 114, length: 4, kind: "e7" },
  { key: "centerZoom", offset: 118, length: 1, kind: "u8" },
  { key: "centerLon", offset: 119, length: 4, kind: "e7" },
  { key: "centerLat", offset: 123, length: 4, kind: "e7" },
] as const;

export type HeaderKey = (typeof HEADER_LAYOUT)[number]["key"];

export interface Header {
  magic: string;
  specVersion: number;
  rootDirectoryOffset: number;
  rootDirectoryLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafDirectoriesOffset: number;
  leafDirectoriesLength: number;
  tileDataOffset: number;
  tileDataLength: number;
  numAddressedTiles: number;
  numTileEntries: number;
  numTileContents: number;
  /** 生の値を保持する（0/1 以外が入っていた場合にそれを表示できるように） */
  clustered: number;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerZoom: number;
  centerLon: number;
  centerLat: number;
}

export interface ParsedHeader {
  header: Header;
  /** 各 field が header バッファ（= file offset 0 起点）のどこから読まれたか */
  spans: Record<HeaderKey, ByteSpan>;
}

export class HeaderError extends Error {
  override name = "HeaderError";
}

/**
 * 127 byte の header を解析する。
 *
 * 公式 bytesToHeader との違い（意図的）:
 * - magic を 7 byte すべて検査する（公式 getHeaderAndRoot は先頭 2 byte "PM" のみ）
 * - version が 3 以外なら拒否する（公式は 3 より大きい場合のみ拒否）
 *   v1/v2 は header レイアウト自体が異なるため、v3 として読むと誤った値を表示してしまう。
 */
export function parseHeader(bytes: Uint8Array): ParsedHeader {
  if (bytes.length < HEADER_SIZE) {
    throw new HeaderError(`header には ${HEADER_SIZE} byte 必要ですが ${bytes.length} byte しかありません`);
  }
  if (!MAGIC.every((b, i) => bytes[i] === b)) {
    throw new HeaderError("magic number が 'PMTiles' ではありません");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_SIZE);

  const values: Record<string, number | string> = {};
  const spans = {} as Record<HeaderKey, ByteSpan>;
  for (const f of HEADER_LAYOUT) {
    spans[f.key] = { offset: f.offset, length: f.length };
    switch (f.kind) {
      case "magic":
        values[f.key] = new TextDecoder().decode(bytes.subarray(0, 7));
        break;
      case "u8":
        values[f.key] = view.getUint8(f.offset);
        break;
      case "u64":
        values[f.key] = readU64(view, f.offset, f.key);
        break;
      case "e7":
        // spec §3.4: 10^7 倍した値を little-endian int32 で格納
        values[f.key] = view.getInt32(f.offset, true) / 10_000_000;
        break;
    }
  }
  const header = values as unknown as Header;
  if (header.specVersion !== 3) {
    throw new HeaderError(`spec version ${header.specVersion} には対応していません（v3 のみ）`);
  }
  return { header, spans };
}

function readU64(view: DataView, offset: number, key: string): number {
  const v = view.getBigUint64(offset, true);
  // 9 PB を超えるアーカイブは現実的でないため number で扱うが、丸めが起きたら黙らず知らせる
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HeaderError(`${key} が Number.MAX_SAFE_INTEGER を超えています: ${v}`);
  }
  return Number(v);
}

export type SectionName = "header" | "rootDirectory" | "metadata" | "leafDirectories" | "tileData";

export interface Section {
  name: SectionName;
  offset: number;
  length: number;
}

/**
 * Header の offset/length から物理配置を求める。
 * spec §2 は header 以外の順序を固定していないため、記載順ではなく offset 順に並べる。
 */
export function sectionsOf(h: Header): Section[] {
  const s: Section[] = [
    { name: "header", offset: 0, length: HEADER_SIZE },
    { name: "rootDirectory", offset: h.rootDirectoryOffset, length: h.rootDirectoryLength },
    { name: "metadata", offset: h.metadataOffset, length: h.metadataLength },
    { name: "leafDirectories", offset: h.leafDirectoriesOffset, length: h.leafDirectoriesLength },
    { name: "tileData", offset: h.tileDataOffset, length: h.tileDataLength },
  ];
  return s.sort((a, b) => a.offset - b.offset || a.length - b.length);
}
