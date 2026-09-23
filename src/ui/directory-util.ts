import type { DirectoryRecord } from "../core/pmtiles/archive";
import type { Entry } from "../core/pmtiles/directory";
import type { Header } from "../core/pmtiles/header";
import type { ByteSpan } from "../core/pmtiles/span";

/**
 * 無圧縮（none / unknown）の directory か。
 * decompress は無圧縮なら入力をそのまま返すので、同一バッファなら「ファイル上の byte = varint の byte」と言える。
 */
export function isPlainDirectory(dir: DirectoryRecord): boolean {
  return dir.compressed === dir.decompressed;
}

/**
 * entry の Offset / Length がファイル上で指す範囲。
 * offset は section 起点の相対値なので、tile entry は Tile Data、leaf entry は Leaf Directories の先頭を足す。
 */
export function entryTarget(entry: Entry, header: Header): ByteSpan & { section: "tileData" | "leafDirectories" } {
  return entry.runLength === 0
    ? { section: "leafDirectories", offset: header.leafDirectoriesOffset + entry.offset, length: entry.length }
    : { section: "tileData", offset: header.tileDataOffset + entry.offset, length: entry.length };
}
